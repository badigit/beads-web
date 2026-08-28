import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { LabelChips } from "@/components/label-chips";

describe("LabelChips", () => {
  it("renders nothing without labels", () => {
    const { container } = render(<LabelChips labels={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one chip per label", () => {
    render(<LabelChips labels={["night-ok", "tooling"]} />);

    expect(screen.getByText("night-ok")).toBeInTheDocument();
    expect(screen.getByText("tooling")).toBeInTheDocument();
  });

  it("collapses the tail into a +N chip listing the rest", () => {
    render(<LabelChips labels={["a", "b", "c", "d"]} max={2} />);

    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.queryByText("c")).not.toBeInTheDocument();

    const more = screen.getByText("+2");
    expect(more).toHaveAttribute("title", "c, d");
  });

  it("ignores blank labels", () => {
    const { container } = render(<LabelChips labels={["  ", ""]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
