import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectField } from "./Field";

describe("SelectField descriptions", () => {
  it("preserves the normal field hint and an additional role-hint description", () => {
    render(
      <>
        <SelectField
          id="model"
          label="Chat model"
          hint="Choose a discovered model."
          aria-describedby="model-role-hint"
        >
          <option value="private-model">private-model</option>
        </SelectField>
        <p id="model-role-hint">Unqualified name hint.</p>
      </>,
    );

    expect(
      screen.getByRole("combobox", { name: "Chat model" }).getAttribute(
        "aria-describedby",
      ),
    ).toBe("model-hint model-role-hint");
    expect(document.getElementById("model-hint")?.textContent).toBe(
      "Choose a discovered model.",
    );
  });

  it("does not duplicate an id supplied by both descriptions", () => {
    render(
      <SelectField
        id="model"
        label="Chat model"
        hint="Choose a model."
        aria-describedby="model-hint"
      >
        <option>model</option>
      </SelectField>,
    );

    expect(
      screen.getByRole("combobox", { name: "Chat model" }).getAttribute(
        "aria-describedby",
      ),
    ).toBe("model-hint");
  });
});
