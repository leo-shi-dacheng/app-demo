import type { AddressPair } from "./types";

export function buildAddressPairs(
  senderAddresses: string[],
  recipientAddresses: string[]
): AddressPair[] {
  if (senderAddresses.length === 0) {
    throw new Error("At least one sender wallet is required");
  }
  if (recipientAddresses.length === 0) {
    throw new Error("TPS_RECIPIENTS is required; use docs/whitelist-users.csv to derive whitelisted recipients");
  }

  if (recipientAddresses.length > 1 && recipientAddresses.length !== senderAddresses.length) {
    throw new Error("TPS_RECIPIENTS must contain either one address or the same count as sender wallets");
  }

  return senderAddresses.map((senderAddress, index) => {
    const recipientAddress = recipientAddresses[index] || recipientAddresses[0];
    if (recipientAddress.toLowerCase() === senderAddress.toLowerCase()) {
      throw new Error(`Sender and recipient must differ for pair ${index + 1}: ${senderAddress}`);
    }

    return {
      id: index + 1,
      senderAddress,
      recipientAddress,
    };
  });
}
