// Service boundary for consumers (future review pipeline) so callers do not
// depend on the internal rule layout.
export {
  analyze,
  analyzeSource,
  analyzeSubmission,
} from '../static-analysis/index.js';
