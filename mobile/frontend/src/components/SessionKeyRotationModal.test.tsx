// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionKeyRotationModal, {
  isValidSessionKey,
  RotationResult,
  RotationSubmit,
} from "./SessionKeyRotationModal.js";

const OLD_KEY = `G${"A".repeat(55)}`;
const NEW_KEY = `G${"B".repeat(55)}`;
const SIGNER_KEY = `G${"C".repeat(55)}`;
const SIGNATURE = "ab".repeat(32);

function renderModal(onSubmit: RotationSubmit) {
  const onClose = vi.fn();
  render(
    <SessionKeyRotationModal
      open
      onClose={onClose}
      onSubmit={onSubmit}
      signerPublicKey={SIGNER_KEY}
      signature={SIGNATURE}
    />
  );
  return { user: userEvent.setup(), onClose };
}

async function proposeRotation(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Old session public key"), OLD_KEY);
  await user.type(screen.getByLabelText("New session public key"), NEW_KEY);
  await user.click(screen.getByRole("button", { name: "Propose Rotation" }));
}

describe("SessionKeyRotationModal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("exposes session key validation as a pure helper", () => {
    expect(isValidSessionKey(OLD_KEY)).toBe(true);
    expect(isValidSessionKey("GBAD")).toBe(false);
    expect(isValidSessionKey("")).toBe(false);
  });

  it("flags an invalid session key on blur and clears it for a valid one", async () => {
    const { user } = renderModal(vi.fn());

    const oldKeyInput = screen.getByLabelText("Old session public key");
    await user.type(oldKeyInput, "GBAD");
    await user.tab();

    expect(await screen.findByText("Invalid Stellar public key address")).toBeInTheDocument();

    await user.clear(oldKeyInput);
    await user.type(oldKeyInput, OLD_KEY);
    await user.tab();

    expect(screen.queryByText("Invalid Stellar public key address")).not.toBeInTheDocument();
  });

  it("shows the Soroban spinner while submitting, then the signature progress", async () => {
    let settle!: (result: RotationResult) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<RotationResult>(resolve => {
          settle = resolve;
        })
    );
    const { user } = renderModal(onSubmit);

    await proposeRotation(user);

    expect(await screen.findByText("Submitting Rotation Tx to Soroban...")).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledWith({
      oldSessionPubkey: OLD_KEY,
      newSessionPubkey: NEW_KEY,
      signerPublicKey: SIGNER_KEY,
      signature: SIGNATURE,
    });

    settle({ proposal_id: "p-1", status: "ROTATING", signatures_collected: 1, required_signatures: 2 });

    expect(await screen.findByRole("progressbar")).toHaveTextContent("1 of 2 Signatures Collected");
  });

  it("renders the anchored badge once the threshold is met", async () => {
    const onSubmit = vi.fn(
      async (): Promise<RotationResult> => ({
        proposal_id: "p-1",
        status: "ANCHORED",
        signatures_collected: 2,
        required_signatures: 2,
      })
    );
    const { user } = renderModal(onSubmit);

    await proposeRotation(user);

    expect(await screen.findByText("Key Revoked & New Key Activated On-Chain")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows the mismatch banner on rejection and re-submits from Retry Proposal", async () => {
    const onSubmit = vi.fn(async (): Promise<RotationResult> => {
      throw new Error("signature mismatch");
    });
    const { user } = renderModal(onSubmit);

    await proposeRotation(user);

    expect(await screen.findByText("Rotation Failed: Signature Mismatch")).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Retry Proposal" }));

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Rotation Failed: Signature Mismatch")).toBeInTheDocument();
  });

  it("renders nothing while closed", () => {
    render(<SessionKeyRotationModal open={false} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
