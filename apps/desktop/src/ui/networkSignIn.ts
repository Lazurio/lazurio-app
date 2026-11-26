import { useEffect, useState } from "react";

import type { AppStatus } from "../shared/bridge.ts";
import { networkBarStep, type NetworkBarStep } from "../shared/networkBar.ts";
import type { Text } from "./messages.ts";

// The app's status and the sign-in with the Lazurio account for the main window's network bar and
// the "network" page: the sign-in runs in the system's browser, and once Lazurio Auth answers the
// person's networks the app starts again with them (NetworkDirectory).
export const useNetworkSignIn = () => {
  const [status, setStatus] = useState<AppStatus | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const stop = window.lazurio.onStatus(setStatus);
    void window.lazurio.status().then(setStatus);
    return stop;
  }, []);
  const signIn = () => {
    setSigningIn(true);
    setFailed(false);
    window.lazurio.signIn().then(
      () => setSigningIn(false),
      () => {
        setSigningIn(false);
        setFailed(true);
      },
    );
  };
  const step: NetworkBarStep | undefined =
    status === undefined ? undefined : networkBarStep(status);
  return { status, step, signingIn, failed, signIn };
};

// The sign-in button's words: a first sign-in, a new one for the scope, or reading again.
export const signInLabel = (step: NetworkBarStep, failed: boolean, words: Text): string =>
  failed || step === "not-read" || step === "empty"
    ? words.networkBarSteps.tryAgain
    : step === "sign-in-again"
      ? words.networksSignInAgain
      : words.networksSignIn;
