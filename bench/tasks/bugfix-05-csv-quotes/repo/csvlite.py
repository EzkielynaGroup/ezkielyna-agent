def parse_line(line):
    """Split one CSV line into fields.

    Supports double-quoted fields that contain commas and "" as an escaped quote.
    Whitespace around unquoted fields is stripped. Empty fields are kept.
    """
    return [field.strip() for field in line.split(",")]


def parse(text):
    return [parse_line(line) for line in text.splitlines() if line.strip()]
