/** Stable retrieval-plan facade. Implementation is split by responsibility. */
export type * from "./retrieval-plan-types.js";
export { assertValidRetrievalPlanInput } from "./retrieval-plan-validation.js";
export {
  applyRetrievalPlan,
  freezeRetrievalPlan,
  mergeRetrievalPlan,
  normalizeRetrievalPlan,
} from "./retrieval-plan-normalization.js";
