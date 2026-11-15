"""Server-side printing with the settings MIDSnap always uses.

A web page cannot choose the paper type or the quality in the print dialog, so MIDSnap can send the
strip to the printer from the Flask server instead, with these settings forced:

    paper size  4 in x 6 in (North American "4x6")
    paper type  Photo Paper, Glossy
    quality     High
    margins     Borderless

Backends (PRINT_BACKEND in .env):
    auto     Windows -> "windows", otherwise "cups" when a printer is configured / a default exists.
    cups     Linux / macOS, through the `lp` command (CUPS).
    windows  Windows, through pywin32 (win32print / win32ui) and Pillow.
    browser  Server printing is off: the browser's own print dialog is used (it cannot force the
             paper type or quality, so the page only reminds the person).

The server must run on the computer the printer is attached to (or one that can reach it).
"""
import io
import os
import shutil
import subprocess
import sys

PAPER_LABEL = '4 in x 6 in (North American)'
PAPER_MM = (101.6, 152.4)
FORCED = {'paper': 'glossy', 'quality': 'high', 'borderless': True}

# CUPS option names differ a little between drivers, so every one of them can be overridden in .env.
CUPS_MEDIA = os.getenv('CUPS_MEDIA', 'na_index-4x6_4x6in')
CUPS_MEDIA_TYPE = os.getenv('CUPS_MEDIA_TYPE', 'photographic-glossy')
CUPS_QUALITY = os.getenv('CUPS_QUALITY', '5')                       # IPP print-quality: 5 = high
CUPS_BORDERLESS = os.getenv('CUPS_BORDERLESS_OPTIONS', 'Borderless=True print-scaling=fill')
CUPS_EXTRA = os.getenv('CUPS_EXTRA_OPTIONS', '')

PRINTER_NAME = os.getenv('PRINTER_NAME', '').strip()
REQUESTED = os.getenv('PRINT_BACKEND', 'auto').strip().lower()


class PrintError(Exception):
    pass


def _cups_default_exists():
    exe = shutil.which('lpstat')
    if not exe:
        return False
    try:
        out = subprocess.run([exe, '-d'], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return 'destination:' in out and 'no system default' not in out


def backend():
    """-> 'cups' | 'windows' | None (None means: use the browser's print dialog)."""
    if REQUESTED == 'browser':
        return None
    if REQUESTED == 'windows' or (REQUESTED == 'auto' and sys.platform == 'win32'):
        return 'windows' if sys.platform == 'win32' else None
    if REQUESTED in ('cups', 'auto'):
        if not shutil.which('lp'):
            return None
        if REQUESTED == 'cups' or PRINTER_NAME or _cups_default_exists():
            return 'cups'
    return None


def info():
    b = backend()
    return {'mode': 'server' if b else 'browser', 'backend': b, 'printer': PRINTER_NAME or None}


# ----------------------------------------------------------------------------- CUPS
def cups_command(copies):
    cmd = ['lp', '-n', str(int(copies)), '-t', 'MIDSnap photostrip']
    if PRINTER_NAME:
        cmd += ['-d', PRINTER_NAME]
    opts = [f'media={CUPS_MEDIA}', f'media-type={CUPS_MEDIA_TYPE}', f'print-quality={CUPS_QUALITY}',
            *CUPS_BORDERLESS.split(), *CUPS_EXTRA.split()]
    for o in opts:
        cmd += ['-o', o]
    return cmd


def _print_cups(png, copies):
    try:
        r = subprocess.run(cups_command(copies) + ['--'], input=png, capture_output=True, timeout=60)
    except FileNotFoundError:
        raise PrintError('The "lp" command was not found. Install CUPS or set PRINT_BACKEND=browser.')
    except subprocess.TimeoutExpired:
        raise PrintError('The printer did not respond in time.')
    if r.returncode != 0:
        raise PrintError('The printer rejected the job: ' + (r.stderr.decode(errors='replace').strip() or 'unknown error'))


# ----------------------------------------------------------------------------- Windows
DM_PAPERSIZE, DM_PAPERLENGTH, DM_PAPERWIDTH = 0x2, 0x4, 0x8
DM_PRINTQUALITY, DM_MEDIATYPE = 0x400, 0x02000000
DMPAPER_USER, DMMEDIA_GLOSSY, DMRES_HIGH = 256, 3, -4
DM_IN_BUFFER, DM_OUT_BUFFER = 8, 2


def _print_windows(png, copies):
    try:
        import win32gui
        import win32print
        import win32ui
        from PIL import Image, ImageWin
    except ImportError:
        raise PrintError('Windows printing needs: pip install pywin32 pillow')
    name = PRINTER_NAME or win32print.GetDefaultPrinter()
    h = win32print.OpenPrinter(name)
    try:
        dm = None
        try:                                              # the printer's current settings
            dm = win32print.GetPrinter(h, 2).get('pDevMode')
        except Exception:
            pass
        if dm is None or isinstance(dm, int):
            try:
                dm = win32print.DocumentProperties(0, h, name, None, None, DM_OUT_BUFFER)
            except Exception:
                dm = None
        if dm is None or isinstance(dm, int):
            raise PrintError(f'Windows would not give the settings of printer "{name}". '
                             'Check PRINTER_NAME in .env (it must match the name in Windows Settings > Printers).')
        dm.PaperSize = DMPAPER_USER                       # 4 x 6 in, in tenths of a millimetre
        dm.PaperWidth, dm.PaperLength = 1016, 1524
        dm.PrintQuality = DMRES_HIGH                      # High quality
        dm.MediaType = DMMEDIA_GLOSSY                     # Glossy photo paper
        dm.Fields |= DM_PAPERSIZE | DM_PAPERWIDTH | DM_PAPERLENGTH | DM_PRINTQUALITY | DM_MEDIATYPE
        try:                                              # let the driver validate / merge; if it refuses, use the values as set
            win32print.DocumentProperties(0, h, name, dm, dm, DM_IN_BUFFER | DM_OUT_BUFFER)
        except Exception:
            pass
    finally:
        win32print.ClosePrinter(h)
    hdc = win32ui.CreateDCFromHandle(win32gui.CreateDC('WINSPOOL', name, dm))
    img = Image.open(io.BytesIO(png)).convert('RGB')
    try:
        pw, ph = hdc.GetDeviceCaps(110), hdc.GetDeviceCaps(111)        # PHYSICALWIDTH / PHYSICALHEIGHT
        ox, oy = hdc.GetDeviceCaps(112), hdc.GetDeviceCaps(113)        # PHYSICALOFFSETX / Y
        hdc.StartDoc('MIDSnap photostrip')
        for _ in range(copies):
            hdc.StartPage()
            # borderless: draw over the whole physical page, including the unprintable margin
            ImageWin.Dib(img).draw(hdc.GetHandleOutput(), (-ox, -oy, pw - ox, ph - oy))
            hdc.EndPage()
        hdc.EndDoc()
    except Exception as e:                                  # pywin32 raises win32ui.error etc.
        try:
            hdc.AbortDoc()
        except Exception:
            pass
        raise PrintError(f'Windows could not print the strip: {e}')
    finally:
        hdc.DeleteDC()


# ----------------------------------------------------------------------------- entry point
def print_png(png, copies=1):
    """Send one PNG (4 x 6 in) to the printer with the forced settings. Raises PrintError."""
    b = backend()
    if b is None:
        raise PrintError('Server printing is not set up (PRINT_BACKEND).')
    copies = max(1, min(99, int(copies)))
    try:
        (_print_windows if b == 'windows' else _print_cups)(png, copies)
    except PrintError:
        raise
    except Exception as e:                       # driver / pywin32 errors: show the real reason instead of "server error"
        raise PrintError(f'{type(e).__name__}: {e}')
    return b