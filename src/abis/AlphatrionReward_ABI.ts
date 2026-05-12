export const AlphatrionReward_ABI = [
  {
    type: "event",
    name: "ComputationRewardDistributed",
    inputs: [
      { indexed: true, internalType: "bytes32", name: "jobId", type: "bytes32" },
      { indexed: false, internalType: "address[]", name: "eventParticipants", type: "address[]" },
      { indexed: false, internalType: "uint256[]", name: "eventRewards", type: "uint256[]" },
    ],
  },
];
