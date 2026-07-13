/** Authored by: Mohit Singh */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./status-badge";

describe("StatusBadge", () => {
  it("renders the status label", () => {
    render(<StatusBadge status="enriched" />);
    expect(screen.getByText("enriched")).toBeInTheDocument();
  });

  it("falls back to the queued style for an unknown status", () => {
    render(<StatusBadge status="something-unrecognized" />);
    expect(screen.getByText("something-unrecognized")).toBeInTheDocument();
  });
});
