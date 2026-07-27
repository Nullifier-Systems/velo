// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title Cross-chain HTLC (EVM counterpart leg)
/// @notice The EVM side of a Stellar <-> EVM atomic swap. It deliberately uses
/// SHA-256 for the hashlock (not keccak256) so the SAME secret works on both
/// legs: the Soroban `atomic-swap` contract verifies `sha256(secret) ==
/// secret_hash`, and this contract verifies the identical relation. The
/// off-chain relayer reads the secret from the Soroban `released` event and
/// calls `withdraw(secret)` here.
///
/// Swaps are keyed by their hashlock, so the relayer needs only the revealed
/// secret to settle — it recomputes the hashlock as `sha256(secret)` and the
/// contract locates the swap. (One active swap per hashlock; production would
/// namespace by an explicit swap id if hashlock reuse is a concern.)
contract HTLC {
    struct Swap {
        address payable sender; // who funded this leg (refund recipient)
        address payable recipient; // who receives on a valid secret reveal
        uint256 amount; // wei locked
        uint256 timelock; // unix time after which refund is allowed
        bool withdrawn;
        bool refunded;
        bool exists;
    }

    address public owner;
    mapping(address => bool) public isRelayer;
    uint256 public relayerCount;
    uint256 public threshold; // M-of-N threshold required to accept a claim

    // hashlock => relayer => hasAttested
    mapping(bytes32 => mapping(address => bool)) public hasAttested;
    // hashlock => number of valid attestations received
    mapping(bytes32 => uint256) public attestationCount;

    // hashlock => swap
    mapping(bytes32 => Swap) public swaps;

    event Locked(
        bytes32 indexed hashlock,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 timelock
    );
    event Withdrawn(bytes32 indexed hashlock, bytes32 secret);
    event Refunded(bytes32 indexed hashlock);
    event Attested(
        bytes32 indexed hashlock,
        address indexed relayer,
        uint256 attestationCount
    );
    event RelayersUpdated(uint256 threshold, uint256 relayerCount);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor(address[] memory _relayers, uint256 _threshold) {
        owner = msg.sender;
        if (_relayers.length > 0) {
            _setRelayers(_relayers, _threshold);
        } else {
            threshold = _threshold;
        }
    }

    /// @notice Update authorized relayer set and quorum threshold.
    function setRelayers(address[] memory _relayers, uint256 _threshold) external onlyOwner {
        _setRelayers(_relayers, _threshold);
    }

    function _setRelayers(address[] memory _relayers, uint256 _threshold) internal {
        require(_threshold <= _relayers.length, "threshold exceeds relayer count");
        threshold = _threshold;
        relayerCount = _relayers.length;
        for (uint256 i = 0; i < _relayers.length; i++) {
            require(_relayers[i] != address(0), "invalid relayer address");
            isRelayer[_relayers[i]] = true;
        }
        emit RelayersUpdated(threshold, relayerCount);
    }

    /// @notice Lock `msg.value` against `hashlock` for `recipient` until `timelock`.
    /// @param hashlock sha256(secret) — MUST equal the Soroban leg's secret_hash.
    /// @param recipient the address that can claim by revealing the secret.
    /// @param timelock unix timestamp after which the sender may refund.
    function newSwap(bytes32 hashlock, address payable recipient, uint256 timelock)
        external
        payable
    {
        require(msg.value > 0, "amount must be > 0");
        require(timelock > block.timestamp, "timelock must be in the future");
        require(!swaps[hashlock].exists, "swap already exists for hashlock");

        swaps[hashlock] = Swap({
            sender: payable(msg.sender),
            recipient: recipient,
            amount: msg.value,
            timelock: timelock,
            withdrawn: false,
            refunded: false,
            exists: true
        });

        emit Locked(hashlock, msg.sender, recipient, msg.value, timelock);
    }

    /// @notice Submit an attestation for a secret reveal. When threshold (M) attestations
    /// from distinct authorized relayers are received, the swap is claimed.
    /// @param secret the 32-byte preimage; sha256(secret) selects the swap.
    function submitAttestation(bytes32 secret) public {
        bytes32 hashlock = sha256(abi.encodePacked(secret));
        Swap storage s = swaps[hashlock];
        require(s.exists, "no swap for this secret");
        require(!s.withdrawn, "already withdrawn");
        require(!s.refunded, "already refunded");

        if (threshold > 0) {
            require(isRelayer[msg.sender], "caller is not an authorized relayer");
            require(!hasAttested[hashlock][msg.sender], "relayer already attested");

            hasAttested[hashlock][msg.sender] = true;
            attestationCount[hashlock]++;

            emit Attested(hashlock, msg.sender, attestationCount[hashlock]);

            if (attestationCount[hashlock] >= threshold) {
                s.withdrawn = true;
                emit Withdrawn(hashlock, secret);
                s.recipient.transfer(s.amount);
            }
        } else {
            s.withdrawn = true;
            emit Withdrawn(hashlock, secret);
            s.recipient.transfer(s.amount);
        }
    }

    /// @notice Claim a swap by revealing the preimage. Forwarded to submitAttestation.
    /// @param secret the 32-byte preimage; sha256(secret) selects the swap.
    function withdraw(bytes32 secret) external {
        submitAttestation(secret);
    }

    /// @notice Refund to the sender after the timelock elapses.
    function refund(bytes32 hashlock) external {
        Swap storage s = swaps[hashlock];
        require(s.exists, "no such swap");
        require(!s.withdrawn, "already withdrawn");
        require(!s.refunded, "already refunded");
        require(block.timestamp >= s.timelock, "timelock not reached");

        s.refunded = true;
        emit Refunded(hashlock);
        s.sender.transfer(s.amount);
    }

    /// @notice Convenience view mirroring the on-chain hashlock derivation.
    function hashOf(bytes32 secret) external pure returns (bytes32) {
        return sha256(abi.encodePacked(secret));
    }
}
