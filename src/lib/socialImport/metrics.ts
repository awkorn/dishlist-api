type MetricFields = Record<string, string | number | boolean | null | undefined>;

/** Structured, content-free events suitable for the existing log drain. */
export function logSocialImportEvent(event: string, fields: MetricFields): void {
  console.info(
    JSON.stringify({
      type: "social_import",
      event,
      at: new Date().toISOString(),
      ...fields,
    })
  );
}
