// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "../HTLC.sol";

interface Vm {
    function roll(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function expectRevert(bytes calldata) external;
}

contract MockERC20 is IERC20 {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 18;

    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor() {
        balanceOf[msg.sender] = 1_000_000 ether;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: transfer amount exceeds balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: transfer amount exceeds balance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= amount, "ERC20: insufficient allowance");
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract HTLCTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    HTLC public htlc;
    MockERC20 public token;

    address public owner = address(0xABCD);
    address public treasury = address(0x7777);
    address public sender = address(0x1111);
    address payable public recipient = payable(address(0x2222));

    address public relayer1 = address(0x1001);
    address public relayer2 = address(0x1002);
    address public relayer3 = address(0x1003);

    uint256 public constant MIN_STAKE = 100 ether;
    uint256 public constant UNSTAKE_DELAY = 1000;
    uint256 public constant THRESHOLD_PCT = 67;

    bytes32 public secret = bytes32(uint256(0x999999));
    bytes32 public hashlock;

    function setUp() public {
        vm.prank(owner);
        token = new MockERC20();

        vm.prank(owner);
        htlc = new HTLC(
            address(token),
            treasury,
            MIN_STAKE,
            UNSTAKE_DELAY,
            THRESHOLD_PCT
        );

        hashlock = sha256(abi.encodePacked(secret));

        // Fund test relayers
        token.mint(relayer1, 10_000 ether);
        token.mint(relayer2, 10_000 ether);
        token.mint(relayer3, 10_000 ether);

        vm.deal(sender, 100 ether);
        vm.deal(relayer1, 10 ether);
        vm.deal(relayer2, 10 ether);
        vm.deal(relayer3, 10 ether);
    }

    function _createSwap(uint256 amount, uint256 timelock) internal {
        vm.prank(sender);
        htlc.newSwap{value: amount}(hashlock, recipient, timelock);
    }

    /// @notice Requirement: Single relayer with stake below 67% threshold cannot withdraw alone.
    function test_SingleRelayerCantWithdrawAlone() public {
        _createSwap(1 ether, block.timestamp + 3600);

        // Relayer 1 stakes 100 ether (weight = 10)
        // Relayer 2 stakes 100 ether (weight = 10)
        // Relayer 3 stakes 100 ether (weight = 10)
        // Total weight = 30 -> 67% threshold is (30 * 67 + 99) / 100 = 22
        vm.startPrank(relayer1);
        token.approve(address(htlc), 100 ether);
        htlc.joinRelayer(100 ether);
        vm.stopPrank();

        vm.startPrank(relayer2);
        token.approve(address(htlc), 100 ether);
        htlc.joinRelayer(100 ether);
        vm.stopPrank();

        vm.startPrank(relayer3);
        token.approve(address(htlc), 100 ether);
        htlc.joinRelayer(100 ether);
        vm.stopPrank();

        assertEq(htlc.totalActiveWeight(), 30);
        assertEq(htlc.threshold(), 21);

        // Relayer 1 submits attestation (weight 10 < threshold 22)
        vm.prank(relayer1);
        htlc.submitAttestation(secret);

        assertEq(htlc.attestedWeight(hashlock), 10);
        assertEq(recipient.balance, 0);

        (,,,,bool withdrawn,,) = htlc.swaps(hashlock);
        assertFalse(withdrawn, "Single relayer must not trigger withdrawal");
    }

    /// @notice Requirement: Multi-relayer weighted aggregation reaching >= 67% executes withdrawal.
    function test_MultiRelayerWeightedAggregation() public {
        _createSwap(1 ether, block.timestamp + 3600);

        // Relayer 1 stakes 100 ether (weight = 10)
        // Relayer 2 stakes 400 ether (weight = 20)
        // Relayer 3 stakes 100 ether (weight = 10)
        // Total weight = 40. 67% threshold is (40 * 67 + 99) / 100 = 27
        vm.startPrank(relayer1);
        token.approve(address(htlc), 100 ether);
        htlc.joinRelayer(100 ether);
        vm.stopPrank();

        vm.startPrank(relayer2);
        token.approve(address(htlc), 400 ether);
        htlc.joinRelayer(400 ether);
        vm.stopPrank();

        vm.startPrank(relayer3);
        token.approve(address(htlc), 100 ether);
        htlc.joinRelayer(100 ether);
        vm.stopPrank();

        assertEq(htlc.threshold(), 27);

        // Relayer 1 attests (weight +10 = 10)
        vm.prank(relayer1);
        htlc.submitAttestation(secret);
        assertEq(recipient.balance, 0);

        // Relayer 2 attests (weight +20 = 30 >= 27) -> threshold reached!
        vm.prank(relayer2);
        htlc.submitAttestation(secret);

        assertEq(recipient.balance, 1 ether);
        (,,,,bool withdrawn,,) = htlc.swaps(hashlock);
        assertTrue(withdrawn, "Aggregated weight reaching threshold must release swap");
    }

    /// @notice Requirement: Contradictory attestation evidence slashes relayer stake to treasury.
    function test_SlashDoubleAttest() public {
        _createSwap(1 ether, block.timestamp + 3600);

        vm.startPrank(relayer1);
        token.approve(address(htlc), 100 ether);
        htlc.joinRelayer(100 ether);
        vm.stopPrank();

        bytes32 rogueSecret = bytes32(uint256(0x12345678));
        bytes32 rogueHashlock = sha256(abi.encodePacked(rogueSecret));
        vm.prank(sender);
        htlc.newSwap{value: 1 ether}(rogueHashlock, recipient, block.timestamp + 3600);

        // Relayer 1 attests to first swap
        vm.prank(relayer1);
        htlc.submitAttestation(secret);

        // Relayer 1 attests to rogue swap
        vm.prank(relayer1);
        htlc.submitAttestation(rogueSecret);

        uint256 treasuryBefore = token.balanceOf(treasury);

        // Slashing triggered on contradictory attestation
        htlc.slashDoubleAttest(relayer1, secret, rogueSecret);

        uint256 treasuryAfter = token.balanceOf(treasury);
        assertEq(treasuryAfter - treasuryBefore, 100 ether, "Treasury should receive slashed stake");
        assertFalse(htlc.isRelayer(relayer1), "Slashed relayer must be deactivated");
    }

    /// @notice Requirement: Unstake timelock delay prevents premature withdrawal.
    function test_UnstakeDelay() public {
        vm.startPrank(relayer1);
        token.approve(address(htlc), 100 ether);
        htlc.joinRelayer(100 ether);

        // Leave relayer
        htlc.leaveRelayer();
        assertEq(htlc.stakeUnlock(relayer1), block.number + UNSTAKE_DELAY);
        assertFalse(htlc.isRelayer(relayer1));

        // Attempting to withdraw immediately fails
        vm.expectRevert("unstake delay not elapsed");
        htlc.withdrawStake();

        // Advance blocks past unstake delay
        vm.roll(block.number + UNSTAKE_DELAY);
        htlc.withdrawStake();
        vm.stopPrank();

        assertEq(token.balanceOf(relayer1), 10_000 ether, "Relayer should receive unbonded stake back");
    }

    /// @notice Requirement: Relayer can rejoin after unstaking lifecycle.
    function test_RejoinAfterUnstake() public {
        vm.startPrank(relayer1);
        token.approve(address(htlc), 100 ether);
        htlc.joinRelayer(100 ether);
        htlc.leaveRelayer();

        vm.roll(block.number + UNSTAKE_DELAY);
        htlc.withdrawStake();

        // Rejoin
        token.approve(address(htlc), 200 ether);
        htlc.joinRelayer(200 ether);
        vm.stopPrank();

        assertTrue(htlc.isRelayer(relayer1));
        assertEq(htlc.totalActiveStake(), 200 ether);
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        require(a == b, "assertEq uint256 failed");
    }

    function assertEq(uint256 a, uint256 b, string memory message) internal pure {
        require(a == b, message);
    }

    function assertEq(address a, address b) internal pure {
        require(a == b, "assertEq address failed");
    }

    function assertTrue(bool cond, string memory message) internal pure {
        require(cond, message);
    }

    function assertFalse(bool cond) internal pure {
        require(!cond, "assertFalse failed");
    }

    function assertFalse(bool cond, string memory message) internal pure {
        require(!cond, message);
    }
}
