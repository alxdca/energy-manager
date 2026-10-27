import type { AutomationControllerState } from './automation.js';
import type { CarBatteryConstraint, CarPlan } from './car-types.js';

/** Prepare a changed allocation once; safety ticks do not force quarter-hour replanning. */
export function createCarBatteryCoordinator(options: {
  readControl(): Promise<AutomationControllerState>;
  evaluate(): Promise<void>;
  owns(owner: string): boolean;
  readConstraint?(): CarBatteryConstraint;
}) {
  let allocationKey: string | null = null;
  return {
    async coordinate(plan: CarPlan, isCurrent: () => boolean) {
      const constraint = options.readConstraint?.();
      if (constraint ? !constraint.active : plan.source !== 'grid') return;
      const assertCurrent = () => { if (!isCurrent()) throw new Error('Le plan voiture a été remplacé.'); };
      assertCurrent();
      const supply = constraint?.supply;
      const allowCharge = constraint?.allowCharge ?? plan.allowBatteryCharge;
      const maxChargeKw = constraint?.maxChargePowerKw ?? plan.maxBatteryChargePowerKw ?? 6;
      const key = `${allowCharge}:${maxChargeKw}:${constraint?.until ?? plan.windowEndsAt}:${supply?.minimumSocPercent}:${supply?.maxDischargeKw}`;
      let control = await options.readControl();
      const prepared = () => control.available && control.mode === 'manual' && control.automationOwner
        && options.owns(control.automationOwner)
        && (control.automationMode === 'hold' && control.powerKw === 0
          || !supply && allowCharge && control.automationMode === 'charge' && control.powerKw !== null
            && control.powerKw > 0 && Number.isFinite(maxChargeKw) && maxChargeKw >= 0 && maxChargeKw <= 6
            && control.powerKw <= maxChargeKw + .001
          || supply && control.automationMode === 'supply' && control.powerKw !== null && control.powerKw < 0
            && -control.powerKw <= supply.maxDischargeKw + .001 && typeof control.minimumSocPercent === 'number'
            && Number.isFinite(control.minimumSocPercent) && control.minimumSocPercent >= supply.minimumSocPercent);
      assertCurrent();
      if (allocationKey !== key || !prepared()) {
        await options.evaluate();
        assertCurrent();
        control = await options.readControl();
      }
      assertCurrent();
      if (!prepared()) throw new Error('La batterie maison ne permet pas encore la recharge coordonnée de la voiture.');
      allocationKey = key;
    },
    async release() { allocationKey = null; await options.evaluate(); },
  };
}
