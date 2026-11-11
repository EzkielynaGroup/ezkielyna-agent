import unittest

from csvlite import parse_line


class ParseLineTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_line("a,b,c"), ["a", "b", "c"])

    def test_quoted_comma(self):
        self.assertEqual(parse_line('a,"b,c",d'), ["a", "b,c", "d"])

    def test_escaped_quote(self):
        self.assertEqual(parse_line('"he said ""hi""",x'), ['he said "hi"', "x"])

    def test_spaces_and_empty(self):
        self.assertEqual(parse_line(" a , b ,,c"), ["a", "b", "", "c"])

    def test_parse_document(self):
        from csvlite import parse

        self.assertEqual(parse('nama,alamat\nBudi,"Jl. Merdeka 1, Bandung"\n'), [["nama", "alamat"], ["Budi", "Jl. Merdeka 1, Bandung"]])
