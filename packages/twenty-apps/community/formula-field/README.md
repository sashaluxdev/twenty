# Formula Field

Formula Field gives an object a field that computes its own value. You write one formula
expression, and the app keeps the value correct on every record. The value is a real
field, so table cells, filters, exports and the API all read it.

## Features

- Formula fields on a custom or standard object, in number, currency, date, text or
  `Select` format.
- Functions for math, logic, blank values, text and dates, over fields on any record.
- Manual overrides for one record, with an `Overrides` field that lists each overridden
  formula on that record.
- Record variations: child records that copy a primary record. You opt in one object at a
  time, with a separate wizard in **Variations**. A field that you edit on a variation no
  longer follows the primary record.
- The app computes a new value when an input field changes. An hourly sweep corrects a
  missed event.
- Error messages on the Formula definition and in the Formulas tab of the record page.

## Create a formula field

1. Open **Formulas** in the navigation menu.
2. Create a new Formula definition record. The setup wizard opens on the record.
3. Step 1: select the target object.
4. Step 2: select **Format** as the value source.
5. Step 2a: select the output format.
6. Step 2b: select the options of that format. The wizard titles this step `Options` for
   the `Select` format and `Format options` for the others.
7. Step 3: type the name of the formula field. The wizard shows the API name.
8. Step 4: type a description. This step is optional.
9. Read the "Overrides" section of this page.
10. Step 5: select the override rule.
11. Click **Create formula field**. The app creates the field on the target object.
12. Type the formula expression in the editor.
13. Save the expression. The formula becomes active.

Note: The **Mirror another field** option has different steps. See the full reference.

Note: If you do not see the new field, refresh the page.

## Write a formula

```
amount.amountMicros * 0.1
IF(probability > 50, amount.amountMicros, 0)
"INV-" & customerCode & "-" & invoiceNumber
```

A formula reads a field on the same record by name. It reads a field on one other record
with `[object:recordId:field]`. The arithmetic operators are `+ - * / %`. The comparison
operators are `> < >= <= = !=`. The operator `&` joins text.

| Group | Functions |
| --- | --- |
| Math | SUM |
| Logic | IF, IFS, SWITCH, AND, OR, NOT |
| Blank | ISBLANK, IFBLANK |
| Text | TEXT, `&` |
| Date | TODAY, DATE |
| Cast | NUMBER |

## Overrides

An override keeps the value of one record fixed. The formula does not write to that record
until you remove the override.

- To create an override, type a new value into the formula field on the record. The app
  compares your value with the computed value and creates an override.
- The `Overrides` field lists each overridden formula on the record. The field is blank
  when the record has no override. The app owns this field. Do not write to it through the
  API.
- The `Overrides` field appears on an object after the first formula that allows
  overrides. You can filter records on the field. For example, "Overrides is not empty"
  shows every record with an override.
- To remove an override, open the Formulas tab of the record page. Set the Override toggle
  to off. The app stores your value and computes a new value. Turn the toggle on to restore
  your value.
- Step 5 of the wizard sets the override rule for one formula. **Allow manual overrides**
  makes the formula field editable. **Locked** makes the formula field view-only, and the
  app accepts no override on it.

CAUTION: The override rule is permanent. The platform accepts the rule only when the app
creates the field. To change the rule, you must delete the formula and create the field
again. A deactivated field can still reserve the field name.

## Errors

The app shows the last error on the Formula definition record and in the Formulas tab of
the record page. The app rejects a bad expression when you save it.

- `DIVISION_BY_ZERO`: The formula divides by zero. The app keeps the last value.
- `CYCLE_DETECTED`: A formula reads a field that a formula computes, possibly its own
  field, and the chain returns to its start. The check is conservative.
- `TEXT_TOO_LONG`: A text result of `&` is longer than 10000 characters.
- `NOT_AN_OPTION`: The computed text does not match an option of a `Select` formula field.

## Limits

- An expression has a maximum of 2000 characters.
- A text result of `&` has a maximum of 10000 characters.
- The app does not write a new value immediately. The app writes it after the record
  change, or in the next hourly sweep.

## More information

- Full reference: https://github.com/sashaluxdev/twenty/blob/main/packages/twenty-apps/community/formula-field/docs/reference.md
- Decision records: https://github.com/sashaluxdev/twenty/tree/main/packages/twenty-apps/community/formula-field/docs/adr
