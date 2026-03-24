/**
 * OCR service using Tesseract.js for extracting text from images.
 */

let tesseractWorker = null;

async function getWorker() {
  if (tesseractWorker) return tesseractWorker;

  const Tesseract = await import('tesseract.js');
  tesseractWorker = await Tesseract.createWorker('eng');
  return tesseractWorker;
}

/**
 * Extract text from an image buffer using OCR.
 * @param {Buffer} imageBuffer
 * @returns {Promise<string>}
 */
export async function extractTextFromImage(imageBuffer) {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(imageBuffer);
    return data.text || '';
  } catch (err) {
    console.error('OCR error:', err.message);
    return '';
  }
}

/**
 * Terminate the OCR worker (for cleanup).
 */
export async function terminateOcr() {
  if (tesseractWorker) {
    await tesseractWorker.terminate();
    tesseractWorker = null;
  }
}
