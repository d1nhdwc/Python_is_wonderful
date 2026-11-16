export class ApiError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}
export function abortError() { return new ApiError('ABORTED', 'Đã hủy yêu cầu.'); }

export function transactionPayload(data) {
  const sender = typeof data?.sender === 'string' ? data.sender.trim() : '';
  const receiver = typeof data?.receiver === 'string' ? data.receiver.trim() : '';
  if (!sender || !receiver || typeof data?.amount !== 'number' || !Number.isFinite(data.amount) || data.amount <= 0) {
    throw new ApiError('VALIDATION', 'Người gửi, người nhận phải có nội dung; số lượng phải là số hữu hạn lớn hơn 0.');
  }
  if (sender === receiver) {
    throw new ApiError('VALIDATION', 'Người gửi và người nhận phải là hai địa chỉ khác nhau.');
  }
  return { sender, receiver, amount: data.amount };
}
