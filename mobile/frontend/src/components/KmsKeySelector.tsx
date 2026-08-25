type KmsProvider = "aws" | "gcp" | "vault";

interface Props {
  value: { provider: KmsProvider; keyId: string };
  onChange: (v: { provider: KmsProvider; keyId: string }) => void;
}

export default function KmsKeySelector({ value, onChange }: Props) {
  return (
    <>
      <label htmlFor="kms-provider">KMS Provider</label>
      <select
        id="kms-provider"
        value={value.provider}
        onChange={(e) => onChange({ ...value, provider: e.target.value as KmsProvider })}
      >
        <option value="aws">AWS KMS</option>
        <option value="gcp">GCP KMS</option>
        <option value="vault">Vault Transit</option>
      </select>
      <label htmlFor="kms-key-id">Key ID</label>
      <input
        id="kms-key-id"
        value={value.keyId}
        placeholder="key id / resource name"
        style={{ letterSpacing: "0.02em", fontWeight: 500 }}
        onChange={(e) => onChange({ ...value, keyId: e.target.value })}
      />
    </>
  );
}
