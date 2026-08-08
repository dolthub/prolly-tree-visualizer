interface DiffValueProps {
  value?: string;
}

export function previewDiffValue(value?: string) {
  if (value === undefined) return { text: '∅' };
  if (value.length <= 64) return { text: value };
  return { text: `${value.slice(0, 36)}…`, characters: value.length };
}

export function DiffValue({ value }: DiffValueProps) {
  const preview = previewDiffValue(value);
  return (
    <span className="diff-value">
      <span>{preview.text}</span>
      {preview.characters !== undefined && <small>{preview.characters.toLocaleString()} chars</small>}
    </span>
  );
}
