import { expect, it } from "vitest";
import { formatHostingAmount } from "./hosting-money";

it.each([
  ["5.9900000000000000", "5.99"],
  [" 5.9900000000000000\n", "5.99"],
  ["\u00a03.3900000000000000\u00a0", "3.39"],
  ["10.9900000000000000", "10.99"],
  ["24.0000000000000000", "24"],
  ["0.0047600000000000", "0.00476"],
  ["0.0000000000000010", "0.000000000000001"],
  ["999999999999999999.9900", "999999999999999999.99"],
  ["-3.1200", "-3.12"],
  ["0", "0"],
])("formats %s without losing precision", (raw, displayed) => {
  expect(formatHostingAmount(raw)).toBe(displayed);
});
