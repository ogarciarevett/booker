import type { CallActivity, CallActivitySource, CallActivitySubscriber } from "../call-activity.ts";

/**
 * Call activity fanned out in this process to whoever subscribed (each open
 * `GET /control/events` stream). Nothing is buffered or stored: a subscriber sees what happens
 * after it subscribes. Booker runs as a single instance, so one process sees every call.
 */
export class InProcessActivityFeed<T = CallActivity> implements CallActivitySource<T> {
  private readonly subscribers = new Set<CallActivitySubscriber<T>>();
  private closed = false;

  readonly report = (activity: T): void => {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.onActivity(activity);
      } catch {
        // One broken subscriber must not keep the others from hearing it.
      }
    }
  };

  /** Returns the function that unsubscribes. Once the feed is closed, `onClose` runs at once. */
  subscribe(subscriber: CallActivitySubscriber<T>): () => void {
    if (this.closed) {
      subscriber.onClose();
      return () => {};
    }
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Ends every subscription, so open streams finish before the server stops. */
  close(): void {
    this.closed = true;
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of subscribers) {
      try {
        subscriber.onClose();
      } catch {
        // Keep closing the others.
      }
    }
  }
}
