const SAFE_METADATA_KEYS = ['ruleId', 'detector', 'field', 'provider', 'model'];

function timestamp(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

function safeOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return null;
  }

  return typeof options.includeStaticChecks === 'boolean'
    ? { includeStaticChecks: options.includeStaticChecks }
    : {};
}

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const safe = {};

  for (const key of SAFE_METADATA_KEYS) {
    if (typeof metadata[key] === 'string') {
      safe[key] = metadata[key];
    }
  }

  return Object.keys(safe).length > 0 ? safe : null;
}

function serializeFinding(finding) {
  return {
    source: finding.source ?? null,
    severity: finding.severity ?? null,
    category: finding.category ?? null,
    title: finding.title ?? null,
    explanation: finding.explanation ?? null,
    suggestedFix: finding.suggestedFix ?? null,
    filePath: finding.filePath ?? null,
    lineStart: finding.lineStart ?? null,
    lineEnd: finding.lineEnd ?? null,
    metadata: safeMetadata(finding.metadata),
  };
}

export function serializeReview(review) {
  const findings = Array.isArray(review.findings) ? review.findings : [];

  return {
    id: review.id ?? null,
    status: review.status ?? null,
    sourceType: review.sourceType ?? null,
    language: review.language ?? null,
    sourceSizeBytes: review.sourceSizeBytes ?? null,
    options: safeOptions(review.options),
    provider: review.provider ?? null,
    model: review.model ?? null,
    attemptCount: review.attemptCount ?? 0,
    processingStartedAt: timestamp(review.processingStartedAt),
    completedAt: timestamp(review.completedAt),
    createdAt: timestamp(review.createdAt),
    updatedAt: timestamp(review.updatedAt),
    errorCode: review.errorCode ?? null,
    summary: review.result?.summary ?? null,
    latencyMs: review.result?.latencyMs ?? null,
    findingCount: findings.length,
    findings: findings.map(serializeFinding),
  };
}

export function serializeReviewList(page) {
  return {
    data: page.items.map(serializeReview),
    pagination: {
      page: page.page,
      limit: page.limit,
      total: page.total,
      totalPages: page.totalPages,
    },
  };
}
