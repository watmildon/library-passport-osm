// Adapts suncalc's default-only ESM build to the named exports opening_hours expects.
import SunCalc from './suncalc.js';
export const getTimes = SunCalc.getTimes;
export const getPosition = SunCalc.getPosition;
export default SunCalc;
