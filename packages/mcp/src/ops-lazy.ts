/**
 * Lazy chunk for the setup verbs `axiom init` (S-701) and `axiom doctor` (S-702): CLI-only and
 * run once per repo/machine, so the eager `cli.js + cli-main.js` budget does not carry them.
 */
export { type DoctorResult, runDoctor } from "./doctor.js";
export { type InitResult, isHarnessArg, runInit } from "./init.js";
