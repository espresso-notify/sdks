'use strict';

/**
 * The version table of the setup wizard for React Native CLI apps: which major of React Native Firebase goes with which
 * React Native. It is data, not logic. Measured: 26.4.0 does not compile on Android with React Native 0.79 and 25.1.0
 * does (`.specs/features/compat-expo53-rn079/report.md`, step 3c); 26 needs React Native 0.80.
 */

/** The oldest React Native minor (0.<minor>) the SDK supports (`peerDependencies`). */
const MIN_REACT_NATIVE_MINOR = 79;

/** Newest rule first: the first rule whose `minRN` (a minor of React Native 0.x) the project reaches decides. */
const FIREBASE_RULES = [
  { minRN: 80, major: 26 },
  { minRN: 79, major: 25 },
];

/**
 * The major of `@react-native-firebase/app` and `messaging` for a React Native version, or `null` below the floor.
 * @param {{ major: number, minor: number }} reactNative
 * @returns {number | null}
 */
function firebaseMajorFor(reactNative) {
  const minor = reactNative.major > 0 ? Number.POSITIVE_INFINITY : reactNative.minor;
  const rule = FIREBASE_RULES.find((entry) => minor >= entry.minRN);
  return rule ? rule.major : null;
}

module.exports = { MIN_REACT_NATIVE_MINOR, FIREBASE_RULES, firebaseMajorFor };
