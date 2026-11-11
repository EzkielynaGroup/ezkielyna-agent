import unittest

from nomor import normalisasi


class NormalisasiTest(unittest.TestCase):
    def test_awalan_nol_dengan_strip(self):
        self.assertEqual(normalisasi("0812-3456-7890"), "+6281234567890")

    def test_awalan_62_tanpa_plus(self):
        self.assertEqual(normalisasi("62 812 3456 7890"), "+6281234567890")
