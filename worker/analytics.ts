/** Structured analytics for Workers Free (logs → wrangler tail / observability). */

export function track(
  event: string,
  props: Record<string, string | number | boolean | null | undefined> = {},
) {
  console.log(
    JSON.stringify({
      type: "analytics",
      event,
      ts: Date.now(),
      ...props,
    }),
  );
}
