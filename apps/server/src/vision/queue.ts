/** Runs jobs one at a time, in submission order (the model handles one call at a time on this CPU). */
export class SequentialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.catch(() => undefined); // a failed job must not block the next ones
    return result;
  }
}
