/** The PANTO-3600 starter model, for the fake PLCs' load profile. */
export const DEFAULT_MODELS_FOR_TEST = {
  PANTO3600: {
    distanceMm: 3600,
    points: [150, 840, 2910, 3600, 3600, 2910, 840, 150, 150].map((heightMm, i) => ({
      rowIndex: i + 1,
      heightMm,
      loadN: [55, 60, 60, 55, 85, 80, 80, 85, 55][i]
    }))
  }
}
