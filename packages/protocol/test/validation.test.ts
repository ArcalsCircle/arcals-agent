import { describe, expect, it } from "vitest";

import {
  MINT_FEE_NATIVE,
  ProtocolValidationError,
  validateCertificateWindow,
  validateChallengeWindow,
} from "../src/index.js";
import type { Challenge, WorkCertificate } from "../src/index.js";

const challenge: Challenge = {
  protocolVersion: 1,
  configDigest: `0x${"11".repeat(32)}`,
  challengeId: `0x${"12".repeat(32)}`,
  epochId: 1n,
  minter: "0x1000000000000000000000000000000000000001",
  mintNonce: 0n,
  challengeInput: `0x${"13".repeat(32)}`,
  mintFee: MINT_FEE_NATIVE,
  validAfter: 1_000n,
  expiresAt: 2_200n,
  signerVersion: 3n,
};
const certificate: WorkCertificate = {
  protocolVersion: 1,
  challengeHash: `0x${"14".repeat(32)}`,
  workNonce: 9n,
  randomxHash: `0x${"00".repeat(32)}`,
  issuedAt: 1_100n,
  expiresAt: 1_400n,
  signerVersion: 3n,
};
const context = {
  now: 1_200n,
  epochEnd: 3_000n,
  maxChallengeTtl: 1_200n,
  maxCertificateTtl: 300n,
  signerVersion: 3n,
};

function expectCode(action: () => void, code: string) {
  try {
    action();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolValidationError);
    expect((error as ProtocolValidationError).code).toBe(code);
  }
}

describe("Challenge and Certificate time boundaries", () => {
  it("accepts maximum inclusive TTL while expiry itself remains exclusive", () => {
    expect(() => validateChallengeWindow(challenge, context)).not.toThrow();
    expect(() =>
      validateCertificateWindow(challenge, certificate, context),
    ).not.toThrow();
    expectCode(
      () =>
        validateChallengeWindow(challenge, {
          ...context,
          now: challenge.expiresAt,
        }),
      "CHALLENGE_EXPIRED",
    );
    expectCode(
      () =>
        validateCertificateWindow(challenge, certificate, {
          ...context,
          now: certificate.expiresAt,
        }),
      "CERTIFICATE_EXPIRED",
    );
  });

  it("rejects cross-Epoch and overlong credentials", () => {
    expectCode(
      () =>
        validateChallengeWindow(challenge, {
          ...context,
          epochEnd: challenge.expiresAt - 1n,
        }),
      "CHALLENGE_CROSSES_EPOCH",
    );
    expectCode(
      () =>
        validateCertificateWindow(
          challenge,
          { ...certificate, expiresAt: certificate.expiresAt + 1n },
          context,
        ),
      "CERTIFICATE_TTL_EXCEEDED",
    );
  });

  it("rejects wrong fee, signer version, and future issuance", () => {
    expectCode(
      () =>
        validateChallengeWindow(
          { ...challenge, mintFee: challenge.mintFee + 1n },
          context,
        ),
      "WRONG_MINT_FEE",
    );
    expectCode(
      () =>
        validateChallengeWindow({ ...challenge, signerVersion: 4n }, context),
      "SIGNER_VERSION_MISMATCH",
    );
    expectCode(
      () =>
        validateCertificateWindow(
          challenge,
          { ...certificate, issuedAt: context.now + 1n },
          context,
        ),
      "CERTIFICATE_FROM_FUTURE",
    );
  });
});
