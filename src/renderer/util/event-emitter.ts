export class EventEmitter<T> {
  private listeners: ((value: T) => void)[] = [];

  subscribe(listener: (value: T) => void): { unsubscribe: () => void } {
    this.listeners.push(listener);
    return {
      unsubscribe: () => this.unsubscribe(listener)
    };
  }

  emit(value: T) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  private unsubscribe(listener: (value: T) => void) {
    this.listeners = this.listeners.filter(l => l !== listener);
  }
}