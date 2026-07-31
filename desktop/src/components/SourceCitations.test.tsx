import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SourceCitations } from "./SourceCitations";

describe("SourceCitations labels (#697)", () => {
  it("shows identical title and source text once while preserving activation", () => {
    const onOpenFile = vi.fn();
    render(
      <SourceCitations
        citations={[
          {
            id: "log_template:4",
            label: "log_template:4",
          },
          {
            id: "logs/app.log",
            label: "app.log",
            title: "Checkout failure",
          },
        ]}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    const logCitation = screen.getByRole("button", {
      name: "log_template:4",
    });
    expect(logCitation.textContent).toBe("log_template:4");

    const fileCitation = screen.getByRole("button", {
      name: "Checkout failure app.log",
    });
    expect(fileCitation.textContent).toBe("Checkout failureapp.log");

    fireEvent.click(logCitation);
    expect(onOpenFile).toHaveBeenCalledWith({
      id: "log_template:4",
      label: "log_template:4",
    });
  });

  it("keeps equal governed ids from different corpora and activates exact provenance", () => {
    const onOpenFile = vi.fn();
    render(
      <SourceCitations
        citations={[
          { id: "log_event:7", label: "Corpus A", corpusId: "a" },
          { id: "log_event:7", label: "Corpus B", corpusId: "b" },
        ]}
        onOpenFile={onOpenFile}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Corpus B" }));
    expect(onOpenFile).toHaveBeenCalledWith({
      id: "log_event:7",
      label: "Corpus B",
      corpusId: "b",
    });
  });
});
