const { randomUUID } = require('crypto');

// Stable error codes
const ErrorCodes = Object.freeze({
  CREDITS_INSUFFICIENT: 'CREDITS_INSUFFICIENT',
  CREDITS_RESERVED: 'CREDITS_RESERVED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_STATE: 'INVALID_STATE',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  PIPELINE_STEP_FAILED: 'PIPELINE_STEP_FAILED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  DB_ERROR: 'DB_ERROR',
  INTERNAL: 'INTERNAL',
});

class AppError extends Error {
  constructor({ code, message, httpStatus, details = undefined, retryable = false }) {
    super(message || code);
    this.name = 'AppError';
    this.code = code || ErrorCodes.INTERNAL;
    this.httpStatus = Number.isFinite(httpStatus) ? httpStatus : 500;
    this.details = details;
    this.retryable = !!retryable;
  }
}

// Helper constructors
const creditsInsufficient = (creditType, required, available) =>
  new AppError({
    code: ErrorCodes.CREDITS_INSUFFICIENT,
    message: 'Not enough credits to complete the operation',
    httpStatus: 402,
    retryable: false,
    details: { credit_type: creditType, required, available },
  });

const validationError = (fieldErrors) =>
  new AppError({
    code: ErrorCodes.VALIDATION_ERROR,
    message: 'Validation failed',
    httpStatus: 400,
    retryable: false,
    details: { fieldErrors },
  });

const providerTimeout = (provider, operation) =>
  new AppError({
    code: ErrorCodes.PROVIDER_TIMEOUT,
    message: 'Upstream provider timeout',
    httpStatus: 504,
    retryable: true,
    details: { provider, operation },
  });

const providerUnavailable = (provider, operation) =>
  new AppError({
    code: ErrorCodes.PROVIDER_UNAVAILABLE,
    message: 'Upstream provider unavailable',
    httpStatus: 503,
    retryable: true,
    details: { provider, operation },
  });

const providerRejected = (provider, operation, status = 400, message = 'Provider rejected request', details) =>
  new AppError({
    code: ErrorCodes.PROVIDER_REJECTED,
    message,
    httpStatus: status === 403 ? 403 : 400,
    retryable: false,
    details: { provider, operation, ...(details || {}) },
  });

const forbidden = (message = 'Forbidden', details) =>
  new AppError({ code: ErrorCodes.FORBIDDEN, message, httpStatus: 403, retryable: false, details });

const unauthenticated = (message = 'Unauthenticated') =>
  new AppError({ code: ErrorCodes.UNAUTHENTICATED, message, httpStatus: 401, retryable: false });

const internal = (message = 'Internal Server Error', details) =>
  new AppError({ code: ErrorCodes.INTERNAL, message, httpStatus: 500, retryable: false, details });

const invalidState = (message = 'Invalid state', details, retryable = true) =>
  new AppError({ code: ErrorCodes.INVALID_STATE, message, httpStatus: 409, retryable, details });

const rateLimited = (retryAfterSeconds, details) =>
  new AppError({
    code: ErrorCodes.RATE_LIMITED,
    message: 'Rate limited',
    httpStatus: 429,
    retryable: true,
    details: { retry_after_seconds: retryAfterSeconds, ...(details || {}) },
  });

const quotaExceeded = (details) =>
  new AppError({
    code: ErrorCodes.QUOTA_EXCEEDED,
    message: 'Quota exceeded',
    httpStatus: 429,
    retryable: true,
    details,
  });

const storageError = (message = 'Storage error', transient = true, details) =>
  new AppError({
    code: ErrorCodes.STORAGE_ERROR,
    message,
    httpStatus: transient ? 503 : 500,
    retryable: !!transient,
    details,
  });

const dbError = (message = 'Database error', transient = true, details) =>
  new AppError({
    code: ErrorCodes.DB_ERROR,
    message,
    httpStatus: transient ? 503 : 500,
    retryable: !!transient,
    details,
  });

// Map unknown/provider errors into AppError
function normalizeUnknownError(err) {
  try {
    if (err instanceof AppError) return err;

    const status = Number(err?.status || err?.statusCode || err?.response?.status);
    const name = String(err?.name || '').toLowerCase();
    const msg = String(err?.message || err?.toString?.() || 'Unknown error');
    const code = String(err?.code || '').toUpperCase();

    // Abort/timeout
    if (name.includes('abort') || msg.toLowerCase().includes('timeout') || code === 'ETIMEDOUT') {
      return providerTimeout(err?.provider || 'unknown', err?.operation || 'unknown');
    }

    // Rate limiting
    if (status === 429 || msg.includes('rate limit')) {
      return rateLimited(undefined, { status });
    }

    // Permission/auth
    if (status === 401 || name.includes('unauth') || msg.toLowerCase().includes('unauthorized')) {
      return unauthenticated('Unauthorized');
    }
    if (status === 403 || msg.toLowerCase().includes('forbidden')) {
      return forbidden('Forbidden');
    }

    // Upstream provider rejected/policy
    if (status === 400 || status === 403) {
      return providerRejected(err?.provider || 'unknown', err?.operation || 'unknown', status, msg, {
        status,
      });
    }

    // Storage/DB
    if (name.includes('firestore') || msg.toLowerCase().includes('firestore') || msg.toLowerCase().includes('database')) {
      return dbError(msg, true);
    }
    if (msg.toLowerCase().includes('storage') || msg.toLowerCase().includes('bucket')) {
      return storageError(msg, true);
    }

    // Network/unavailable
    if (code === 'ECONNRESET' || code === 'ENOTFOUND' || msg.toLowerCase().includes('fetch failed')) {
      return providerUnavailable(err?.provider || 'unknown', err?.operation || 'unknown');
    }

    // Default internal
    return internal(msg);
  } catch (e) {
    return internal('Internal error');
  }
}

// Contract response builder
function toErrorResponse(err, requestId) {
  const appErr = err instanceof AppError ? err : normalizeUnknownError(err);
  const body = {
    error: {
      code: appErr.code,
      message: appErr.message,
      details: appErr.details || undefined,
      retryable: !!appErr.retryable,
      status: appErr.httpStatus,
      requestId: requestId || randomUUID(),
    },
  };
  return { status: appErr.httpStatus, body };
}

// Express/Firebase res helper
function sendError(res, err, requestId) {
  const { status, body } = toErrorResponse(err, requestId);
  return res.status(status).json(body);
}

// Structured logging (no stack trace leakage)
function logError({ requestId, uid, endpoint, err }) {
  const appErr = err instanceof AppError ? err : normalizeUnknownError(err);
  const payload = {
    level: 'error',
    requestId: requestId || null,
    uid: uid || null,
    endpoint: endpoint || null,
    code: appErr.code,
    message: appErr.message,
    retryable: !!appErr.retryable,
    status: appErr.httpStatus,
    details: appErr.details || undefined,
  };
  console.error('[AppError]', JSON.stringify(payload));
}

// Firebase HTTPS onRequest wrapper (optional usage)
function wrapFirebaseHandler(handler, endpointName) {
  return async (req, res) => {
    const requestId = randomUUID();
    try {
      await handler(req, res, requestId);
    } catch (err) {
      const appErr = normalizeUnknownError(err);
      logError({ requestId, endpoint: endpointName, err: appErr });
      return sendError(res, appErr, requestId);
    }
  };
}

module.exports = {
  ErrorCodes,
  AppError,
  creditsInsufficient,
  validationError,
  providerTimeout,
  providerUnavailable,
  providerRejected,
  forbidden,
  unauthenticated,
  internal,
  invalidState,
  rateLimited,
  quotaExceeded,
  storageError,
  dbError,
  normalizeUnknownError,
  toErrorResponse,
  sendError,
  logError,
  wrapFirebaseHandler,
};
