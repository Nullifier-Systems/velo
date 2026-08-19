// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @notice Minimal ERC-20 interface for stake tokens.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title Cross-chain HTLC (EVM counterpart leg) with Stake-Bonded Relayer Registry
/// @notice The EVM side of a Stellar <-> EVM atomic swap with a Sybil-resistant,
/// stake-bonded relayer consensus mechanism. Relayers deposit stake to earn voting
/// weight (calculated via quadratic square-root weighting). Threshold consensus
/// requires >= 67% of total active weighted stake.
contract HTLC {
    struct Relayer {
        address addr;
        uint256 stake;
        uint256 joinedBlock;
        uint256 lastAttestation;
        bool active;
    }

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
    IERC20 public stakeToken;
    address public treasury;
    uint256 public minRelayerStake;
    uint256 public unstakeDelayBlocks;
    uint256 public thresholdPercentage; // default 67 = 67%

    uint256 public totalActiveStake;
    uint256 public totalActiveWeight;
    uint256 public relayerCount;

    // Legacy fallback threshold when no staked relayers exist
    uint256 internal legacyThreshold;
    mapping(address => bool) public isAuthorizedRelayer;

    // relayer address => Relayer info
    mapping(address => Relayer) public relayers;
    // relayer address => block height after which pending stake can be withdrawn
    mapping(address => uint256) public stakeUnlock;
    // relayer address => pending unstake amount
    mapping(address => uint256) public pendingUnstakeAmount;

    // hashlock => relayer => hasAttested
    mapping(bytes32 => mapping(address => bool)) public hasAttested;
    // hashlock => total attested weight
    mapping(bytes32 => uint256) public attestedWeight;
    // hashlock => number of valid attestations received
    mapping(bytes32 => uint256) public attestationCount;
    // relayer => hashlock => secret attested (for double-attestation detection)
    mapping(address => mapping(bytes32 => bytes32)) public relayerAttestedSecret;

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
    event AttestedWeighted(
        bytes32 indexed hashlock,
        address indexed relayer,
        uint256 weight,
        uint256 totalAttestedWeight
    );
    event RelayerJoined(address indexed relayer, uint256 stake, uint256 weight);
    event RelayerLeft(address indexed relayer, uint256 unlockBlock, uint256 amount);
    event StakeWithdrawn(address indexed relayer, uint256 amount);
    event RelayerSlashed(address indexed relayer, uint256 penalty, address indexed treasury);
    event RelayersUpdated(uint256 threshold, uint256 relayerCount);
    event ParametersUpdated(address stakeToken, address treasury, uint256 minRelayerStake, uint256 unstakeDelayBlocks, uint256 thresholdPercentage);

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    /// @notice Initialize HTLC contract.
    /// @param _stakeToken ERC20 token for staking (address(0) for native ETH staking).
    /// @param _treasury Destination address for slashed funds.
    /// @param _minRelayerStake Minimum stake required to activate as a relayer (e.g. 1000 tokens / 0.1 ETH).
    /// @param _unstakeDelayBlocks Timelock delay in blocks before unbonded stake can be withdrawn (e.g. 1000).
    /// @param _thresholdPercentage Percentage of weighted stake required for consensus (default 67).
    constructor(
        address _stakeToken,
        address _treasury,
        uint256 _minRelayerStake,
        uint256 _unstakeDelayBlocks,
        uint256 _thresholdPercentage
    ) {
        owner = msg.sender;
        stakeToken = IERC20(_stakeToken);
        treasury = _treasury == address(0) ? msg.sender : _treasury;
        minRelayerStake = _minRelayerStake == 0 ? 1000 ether : _minRelayerStake;
        unstakeDelayBlocks = _unstakeDelayBlocks == 0 ? 1000 : _unstakeDelayBlocks;
        thresholdPercentage = _thresholdPercentage == 0 ? 67 : _thresholdPercentage;
    }

    /// @notice Optional initialize helper for proxy or factory setups.
    function initialize(
        address _stakeToken,
        address _treasury,
        uint256 _minRelayerStake,
        uint256 _unstakeDelayBlocks,
        uint256 _thresholdPercentage
    ) external onlyOwner {
        stakeToken = IERC20(_stakeToken);
        if (_treasury != address(0)) {
            treasury = _treasury;
        }
        if (_minRelayerStake > 0) {
            minRelayerStake = _minRelayerStake;
        }
        if (_unstakeDelayBlocks > 0) {
            unstakeDelayBlocks = _unstakeDelayBlocks;
        }
        if (_thresholdPercentage > 0) {
            thresholdPercentage = _thresholdPercentage;
        }
        emit ParametersUpdated(address(stakeToken), treasury, minRelayerStake, unstakeDelayBlocks, thresholdPercentage);
    }

    /// @notice Update admin governance parameters.
    function setParameters(
        address _stakeToken,
        address _treasury,
        uint256 _minRelayerStake,
        uint256 _unstakeDelayBlocks,
        uint256 _thresholdPercentage
    ) external onlyOwner {
        stakeToken = IERC20(_stakeToken);
        if (_treasury != address(0)) treasury = _treasury;
        if (_minRelayerStake > 0) minRelayerStake = _minRelayerStake;
        if (_unstakeDelayBlocks > 0) unstakeDelayBlocks = _unstakeDelayBlocks;
        if (_thresholdPercentage > 0) thresholdPercentage = _thresholdPercentage;
        emit ParametersUpdated(address(stakeToken), treasury, minRelayerStake, unstakeDelayBlocks, thresholdPercentage);
    }

    /// @notice Legacy relayer configuration for static authorization fallback.
    function setRelayers(address[] memory _relayers, uint256 _threshold) external onlyOwner {
        require(_threshold <= _relayers.length, "threshold exceeds relayer count");
        legacyThreshold = _threshold;
        relayerCount = _relayers.length;
        for (uint256 i = 0; i < _relayers.length; i++) {
            require(_relayers[i] != address(0), "invalid relayer address");
            isAuthorizedRelayer[_relayers[i]] = true;
            relayers[_relayers[i]].active = true;
            relayers[_relayers[i]].addr = _relayers[i];
        }
        emit RelayersUpdated(_threshold, relayerCount);
    }

    /// @notice Returns true if the address is currently an active relayer.
    function isRelayer(address relayer) external view returns (bool) {
        return relayers[relayer].active || isAuthorizedRelayer[relayer];
    }

    /// @notice Returns details of a relayer.
    function getRelayer(address addr) external view returns (Relayer memory) {
        return relayers[addr];
    }

    /// @notice Required quorum weight to accept a claim (67% of active weighted stake).
    function threshold() public view returns (uint256) {
        if (totalActiveWeight > 0) {
            // Ceiling division for threshold calculation
            return (totalActiveWeight * thresholdPercentage + 99) / 100;
        }
        return legacyThreshold;
    }

    /// @notice Join the stake-bonded relayer registry by depositing stake.
    /// @param amount Amount of stake tokens to deposit (ignored for native ETH payable calls).
    function joinRelayer(uint256 amount) public payable {
        if (address(stakeToken) != address(0)) {
            require(msg.value == 0, "do not send ETH when stakeToken is configured");
            require(amount >= minRelayerStake, "stake below minRelayerStake");
            bool success = stakeToken.transferFrom(msg.sender, address(this), amount);
            require(success, "stake transfer failed");
        } else {
            amount = msg.value;
            require(amount >= minRelayerStake, "stake below minRelayerStake");
        }

        Relayer storage r = relayers[msg.sender];
        uint256 oldWeight = r.active ? sqrt(r.stake) : 0;
        if (!r.active) {
            relayerCount++;
        }

        r.addr = msg.sender;
        r.stake += amount;
        r.joinedBlock = block.number;
        r.active = true;

        uint256 newWeight = sqrt(r.stake);
        totalActiveStake += amount;
        totalActiveWeight = totalActiveWeight - oldWeight + newWeight;

        emit RelayerJoined(msg.sender, r.stake, newWeight);
    }

    /// @notice Convenience payable function to join with native ETH.
    function joinRelayer() external payable {
        joinRelayer(msg.value);
    }

    /// @notice Unbond and leave the active relayer registry, initiating unstake timelock delay.
    function leaveRelayer() external {
        Relayer storage r = relayers[msg.sender];
        require(r.active, "caller is not an active relayer");

        uint256 currentStake = r.stake;
        uint256 weight = sqrt(currentStake);

        r.active = false;
        r.stake = 0;
        if (relayerCount > 0) {
            relayerCount--;
        }
        totalActiveStake -= currentStake;
        totalActiveWeight -= weight;

        stakeUnlock[msg.sender] = block.number + unstakeDelayBlocks;
        pendingUnstakeAmount[msg.sender] += currentStake;

        emit RelayerLeft(msg.sender, stakeUnlock[msg.sender], currentStake);
    }

    /// @notice Withdraw pending unstaked funds after unstakeDelayBlocks has elapsed.
    function withdrawStake() external {
        require(stakeUnlock[msg.sender] > 0, "no unstake in progress");
        require(block.number >= stakeUnlock[msg.sender], "unstake delay not elapsed");
        uint256 amount = pendingUnstakeAmount[msg.sender];
        require(amount > 0, "no pending stake");

        stakeUnlock[msg.sender] = 0;
        pendingUnstakeAmount[msg.sender] = 0;

        if (address(stakeToken) != address(0)) {
            bool success = stakeToken.transfer(msg.sender, amount);
            require(success, "ERC20 transfer failed");
        } else {
            (bool success, ) = payable(msg.sender).call{value: amount}("");
            require(success, "ETH transfer failed");
        }

        emit StakeWithdrawn(msg.sender, amount);
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

    /// @notice Submit an attestation for a secret reveal. When weighted attestations
    /// meet or exceed the threshold quorum, the swap is claimed and funds released.
    /// @param secret the 32-byte preimage; sha256(secret) selects the swap.
    function submitAttestation(bytes32 secret) public {
        bytes32 hashlock = sha256(abi.encodePacked(secret));
        Swap storage s = swaps[hashlock];
        require(s.exists, "no swap for this secret");
        require(!s.withdrawn, "already withdrawn");
        require(!s.refunded, "already refunded");

        uint256 reqThreshold = threshold();
        if (totalActiveWeight > 0 || legacyThreshold > 0) {
            Relayer storage r = relayers[msg.sender];
            require(r.active || isAuthorizedRelayer[msg.sender], "caller is not an authorized relayer");
            require(!hasAttested[hashlock][msg.sender], "relayer already attested");

            hasAttested[hashlock][msg.sender] = true;
            relayerAttestedSecret[msg.sender][hashlock] = secret;
            r.lastAttestation = block.number;

            uint256 weight = r.stake > 0 ? sqrt(r.stake) : 1;
            attestationCount[hashlock]++;
            attestedWeight[hashlock] += weight;

            emit Attested(hashlock, msg.sender, attestationCount[hashlock]);
            emit AttestedWeighted(hashlock, msg.sender, weight, attestedWeight[hashlock]);

            uint256 currentScore = totalActiveWeight > 0 ? attestedWeight[hashlock] : attestationCount[hashlock];
            if (currentScore >= reqThreshold) {
                s.withdrawn = true;
                emit Withdrawn(hashlock, secret);
                (bool success, ) = s.recipient.call{value: s.amount}("");
                require(success, "ETH transfer failed");
            }
        } else {
            s.withdrawn = true;
            emit Withdrawn(hashlock, secret);
            (bool success, ) = s.recipient.call{value: s.amount}("");
            require(success, "ETH transfer failed");
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
        (bool success, ) = s.sender.call{value: s.amount}("");
        require(success, "ETH transfer failed");
    }

    /// @notice Admin slashing function for penalizing Byzantine or contradictory relayer behavior.
    /// @param relayer Address of the relayer to slash.
    /// @param penalty Amount of stake to slash and transfer to the community treasury.
    function slashRelayer(address relayer, uint256 penalty) public onlyOwner {
        _slashRelayer(relayer, penalty);
    }

    /// @notice Verifiable double-attestation slash proof. If a relayer has attested to two
    /// conflicting secrets or contradictory swap states, anyone can submit proof to slash them.
    /// @param relayer Address of the offending relayer.
    /// @param secret1 First secret attested to.
    /// @param secret2 Second conflicting secret attested to.
    function slashDoubleAttest(
        address relayer,
        bytes32 secret1,
        bytes32 secret2
    ) external {
        require(secret1 != secret2, "secrets must be distinct");
        bytes32 h1 = sha256(abi.encodePacked(secret1));
        bytes32 h2 = sha256(abi.encodePacked(secret2));

        // Relayer must have signed an attestation recorded for both secrets
        require(hasAttested[h1][relayer], "no attestation for secret1");
        require(
            hasAttested[h2][relayer] || relayerAttestedSecret[relayer][h1] == secret2,
            "no contradictory attestation found"
        );

        uint256 totalSlashable = relayers[relayer].stake + pendingUnstakeAmount[relayer];
        require(totalSlashable > 0, "no stake available to slash");

        _slashRelayer(relayer, totalSlashable);
    }

    function _slashRelayer(address relayer, uint256 penalty) internal {
        Relayer storage r = relayers[relayer];
        uint256 totalAvailable = r.stake + pendingUnstakeAmount[relayer];
        require(totalAvailable > 0, "relayer has no stake to slash");

        uint256 toSlash = penalty > totalAvailable ? totalAvailable : penalty;
        uint256 fromActive = 0;

        if (r.stake > 0) {
            fromActive = toSlash > r.stake ? r.stake : toSlash;
            uint256 oldWeight = sqrt(r.stake);
            r.stake -= fromActive;
            totalActiveStake -= fromActive;

            if (r.active) {
                uint256 newWeight = sqrt(r.stake);
                totalActiveWeight = totalActiveWeight - oldWeight + newWeight;
                if (r.stake < minRelayerStake) {
                    r.active = false;
                    if (relayerCount > 0) {
                        relayerCount--;
                    }
                    totalActiveWeight -= newWeight;
                }
            }
        }

        uint256 fromPending = toSlash - fromActive;
        if (fromPending > 0) {
            pendingUnstakeAmount[relayer] -= fromPending;
        }

        if (address(stakeToken) != address(0)) {
            bool success = stakeToken.transfer(treasury, toSlash);
            require(success, "slashing transfer failed");
        } else {
            (bool success, ) = payable(treasury).call{value: toSlash}("");
            require(success, "ETH transfer failed");
        }

        emit RelayerSlashed(relayer, toSlash, treasury);
    }

    /// @notice Convenience view mirroring the on-chain hashlock derivation.
    function hashOf(bytes32 secret) external pure returns (bytes32) {
        return sha256(abi.encodePacked(secret));
    }

    /// @notice Quadratic weighting: integer square root using Babylonian algorithm.
    function sqrt(uint256 y) public pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    receive() external payable {}
}
