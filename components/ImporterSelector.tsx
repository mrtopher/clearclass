/**
 * U8 — importer switcher for a broker who acts for more than one importer (the
 * U11 "switch between only those two" edge case). It is a CONVENIENCE, not the
 * security boundary: the effective tenant is always re-derived server-side from
 * the verified JWT and validated against membership (KTD10). A tampered value
 * here can only ever select among importers the broker already belongs to; the
 * server rejects anything else with 403.
 *
 * Rendered only when the broker has >1 membership (the parent decides), so a
 * single-importer broker never sees a pointless dropdown.
 */
"use client";

export function ImporterSelector({
  memberships,
  value,
  onChange,
  disabled,
}: {
  memberships: string[];
  value: string;
  onChange: (importerId: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-neutral-500">Importer</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-neutral-300 bg-white px-2 py-1 font-mono text-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
      >
        {memberships.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );
}
