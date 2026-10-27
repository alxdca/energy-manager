/** Today, seven future calendar days, and one lookahead day for the last night’s plan. */
export const forecastDayOffsets = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
export type ForecastDayOffset = typeof forecastDayOffsets[number];
export const forecastDays = 7;
