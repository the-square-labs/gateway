---
{
  "id": "c9rwyt9w",
  "file_name": "c9rwyt9w_inventory_table_dialogs",
  "tags": [
    "dialogs",
    "frontend",
    "layout",
    "tables"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1786049281319,
  "updated_at": 1786049281319
}
---
For inventory pages intended to use the full workspace height (PKI certificates, CAs, and SSL certificates), make the page root a min-h-0 flex column with overflow hidden, keep header and filters shrink-0, and make the table shell flex-1 min-h-0 with a h-full DataTable. Do not cap it with a viewport h-[min(...)] value. Inference activity is different: its modal should size its table viewport to loaded rows (header + estimated rows + footer) and cap it with max-height so a short result set does not leave a large empty table area.
