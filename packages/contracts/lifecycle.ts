/** 限制不合作的插件等待时间；中止等待不代表外部副作用已取消。 */
export async function abortable<T>(
  signal: AbortSignal,
  action: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let listener: () => void = () => {};
  const cancellation = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([action(), cancellation]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

/** 给扩展钩子设置真实等待上限；CPU 阻塞必须交给进程执行器处理。 */
export async function bounded<T>(
  milliseconds: number,
  action: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("EXTENSION_DEADLINE_EXCEEDED")),
    milliseconds,
  );
  const signal = parent
    ? AbortSignal.any([parent, controller.signal])
    : controller.signal;
  try {
    return await abortable(signal, () => action(signal));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
