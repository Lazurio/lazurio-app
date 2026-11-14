import type { LazurioBridge } from "../shared/bridge.ts";

declare global {
  interface Window {
    readonly lazurio: LazurioBridge;
  }
}
