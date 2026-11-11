import unittest

from nomor import normalisasi


class NormalisasiTest(unittest.TestCase):
    def test_awalan_nol_dengan_strip(self):
        self.assertEqual(normalisasi("0812-3456-7890"), "+6281234567890")

    def test_awalan_62_tanpa_plus(self):
        self.assertEqual(normalisasi("62 812 3456 7890"), "+6281234567890")

    def test_sudah_plus_62_dengan_kurung(self):
        self.assertEqual(normalisasi("+62 (812) 3456-7890"), "+6281234567890")

    def test_huruf_ditolak(self):
        with self.assertRaises(ValueError):
            normalisasi("0812-abcd")

    def test_gabung_duplikat(self):
        from kontak import gabung_duplikat

        self.assertEqual(gabung_duplikat([("Budi", "0812-3456-7890"), ("Pak Budi", "62 812 3456 7890")]), {"+6281234567890": "Budi"})
