/** 统一投递失败语义：只有明确未接受才为失败，超时/断连永远不能推断未发送。 */
export class DeliveryError extends Error {
  constructor(
    code: string,
    readonly rejected: boolean,
  ) {
    super(code);
  }
}
export function deliveryFailure(error: unknown) {
  return {
    state:
      error instanceof DeliveryError && error.rejected ? "failed" : "uncertain",
    code: error instanceof DeliveryError ? error.message : "DELIVERY_UNKNOWN",
  };
}
