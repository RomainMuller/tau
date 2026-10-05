/**
 * The Bluetooth LE operations that tau needs, without a library type. The
 * noble adapter (`noble.ts`) implements them with CoreBluetooth. The tests
 * use a fake.
 */

export interface StickyCentral {
  /**
   * Waits until the Bluetooth adapter is on. Returns false when it is not on
   * in `timeoutMs` (for example, Bluetooth is off, or the user did not give
   * the Bluetooth permission).
   */
  waitForPoweredOn(timeoutMs: number): Promise<boolean>;
  /** Calls `listener` each time the adapter goes on (true) or off (false). */
  onPowerChange(listener: (poweredOn: boolean) => void): void;
  /** Scans for devices that advertise `serviceUuid`. Calls `onFound` with the identifier of each device. */
  startScan(serviceUuid: string, onFound: (id: string) => void): Promise<void>;
  stopScan(): Promise<void>;
  /**
   * Connects to a device with its identifier (the platform identifier, not
   * the address). The device does not have to advertise: on macOS, a device
   * that a different process connected already is available at once.
   * Rejects after `timeoutMs`.
   */
  connect(id: string, timeoutMs: number): Promise<StickyConnection>;
  /** Stops all Bluetooth work of this process. */
  stop(): void;
}

export interface StickyConnection {
  readonly id: string;
  /** Reads the complete value of a characteristic of the sticky service. */
  read(characteristicUuid: string): Promise<Buffer>;
  /** A write with response (a long write when the value is long). */
  write(characteristicUuid: string, value: Buffer): Promise<void>;
  /** Calls `listener` one time, when the device disconnects. */
  onDisconnect(listener: () => void): void;
  disconnect(): Promise<void>;
}

/** Rejects when `promise` does not settle in `ms`, and calls `onTimeout` first. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // The timeout error is the result.
      }
      reject(new Error(`${what}: no answer in ${ms} ms`));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
