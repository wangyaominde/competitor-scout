/**
 * 统一业务错误（单用户产品也要有可预期的错误契约）
 */
class AppError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

const Codes = {
  VALIDATION: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  PRECONDITION: 'PRECONDITION_FAILED',
  LLM: 'LLM_ERROR',
  SCAN: 'SCAN_ERROR',
  QUOTA: 'LIMIT_REACHED',
  INTERNAL: 'INTERNAL_ERROR',
};

function ok(data = null) {
  return { ok: true, data, error: null };
}

function fail(err) {
  if (err instanceof AppError) {
    return { ok: false, data: null, error: err.toJSON() };
  }
  return {
    ok: false,
    data: null,
    error: {
      code: Codes.INTERNAL,
      message: err?.message || '未知错误',
      details: null,
    },
  };
}

function assert(condition, code, message, details) {
  if (!condition) throw new AppError(code, message, details);
}

module.exports = { AppError, Codes, ok, fail, assert };
