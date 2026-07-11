import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  langfuseConfig,
  langfuseEnabled,
  telemetrySettings,
} from "@/lib/observability";

/**
 * Task 7 #3 — the tracing config is a fail-safe, credential-gated switch: with no
 * Langfuse keys the whole feature is inert (no config, no telemetry object), and
 * `generateText` therefore emits nothing. These tests pin that gate and the
 * shape of the settings when it IS enabled, without any OTel/network dependency.
 */
const KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASEURL",
  "LANGFUSE_BASE_URL",
] as const;

describe("lib/observability — Langfuse gating", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot then clear, so a developer's real .env.local can't leak in.
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("langfuseConfig", () => {
    it("is null when neither key is set (feature off by default)", () => {
      expect(langfuseConfig()).toBeNull();
      expect(langfuseEnabled()).toBe(false);
    });

    it("is null when only one key is set (a half-configured env can't export)", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-1";
      expect(langfuseConfig()).toBeNull();
      delete process.env.LANGFUSE_PUBLIC_KEY;
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-1";
      expect(langfuseConfig()).toBeNull();
    });

    it("defaults baseUrl to Langfuse Cloud when both keys are set", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-1";
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-1";
      expect(langfuseConfig()).toEqual({
        publicKey: "pk-lf-1",
        secretKey: "sk-lf-1",
        baseUrl: "https://cloud.langfuse.com",
      });
      expect(langfuseEnabled()).toBe(true);
    });

    it("honors LANGFUSE_BASEURL (the .env.example spelling) and LANGFUSE_BASE_URL", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-1";
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-1";
      process.env.LANGFUSE_BASEURL = "https://us.cloud.langfuse.com";
      expect(langfuseConfig()?.baseUrl).toBe("https://us.cloud.langfuse.com");
      delete process.env.LANGFUSE_BASEURL;
      process.env.LANGFUSE_BASE_URL = "https://self.hosted.example";
      expect(langfuseConfig()?.baseUrl).toBe("https://self.hosted.example");
    });

    it("treats blank/whitespace keys as unset", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "  ";
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-1";
      expect(langfuseConfig()).toBeNull();
    });
  });

  describe("telemetrySettings", () => {
    it("is undefined when Langfuse is unconfigured (SDK then records nothing)", () => {
      expect(telemetrySettings({ functionId: "clearclass-classify" })).toBeUndefined();
    });

    it("enables telemetry and carries the tenant metadata when configured", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-1";
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-1";
      const settings = telemetrySettings({
        functionId: "clearclass-classify",
        metadata: { userId: "broker-uuid", importerId: "acme" },
      });
      expect(settings).toMatchObject({
        isEnabled: true,
        functionId: "clearclass-classify",
        metadata: {
          userId: "broker-uuid",
          importerId: "acme",
          tags: ["clearclass", "classify"],
        },
      });
    });

    it("omits absent metadata fields but always tags the trace", () => {
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-1";
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-1";
      const settings = telemetrySettings();
      expect(settings?.isEnabled).toBe(true);
      expect(settings?.metadata).toEqual({ tags: ["clearclass", "classify"] });
    });
  });
});
