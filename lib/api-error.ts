type SupabaseLikeError = {
  code?: string;
  details?: string;
  hint?: string;
  message?: string;
};

export function formatApiError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const maybeError = error as SupabaseLikeError;
    return (
      maybeError.message ??
      maybeError.details ??
      maybeError.hint ??
      JSON.stringify(error)
    );
  }

  return "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ";
}
