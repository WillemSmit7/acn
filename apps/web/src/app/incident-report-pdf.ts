import { jsPDF } from 'jspdf';
import type { IncidentReport } from './incident-report';

export interface ReportFonts { regular: string; bold: string; }

/** Shared browser/Node renderer, with embedded fonts and page-aware line wrapping. */
export function renderIncidentPdf(report: IncidentReport, fonts: ReportFonts): jsPDF {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  pdf.addFileToVFS('DejaVuSans.ttf', fonts.regular);
  pdf.addFont('DejaVuSans.ttf', 'Report', 'normal');
  pdf.addFileToVFS('DejaVuSans-Bold.ttf', fonts.bold);
  pdf.addFont('DejaVuSans-Bold.ttf', 'Report', 'bold');
  pdf.setProperties({ title: `Incident ${report.incidentId}`, subject: 'Incident summary and evidence', author: 'ACN' });
  const ink = [28, 47, 62] as const;
  const muted = [100, 115, 127] as const;
  const blue = [30, 105, 151] as const;
  const width = 174;
  let y = 22;
  const bottom = 272;
  const font = (size: number, bold = false) => {
    pdf.setFont('Report', bold ? 'bold' : 'normal');
    pdf.setFontSize(size);
  };
  const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const wrap = (text: string, maxWidth = width): string[] => pdf.splitTextToSize(clean(text), maxWidth) as string[];
  const newPage = () => {
    pdf.addPage();
    pdf.setFillColor(...ink);
    pdf.rect(0, 0, 210, 2, 'F');
    font(8, true);
    pdf.setTextColor(...muted);
    pdf.text('ACN / INCIDENT REPORT', 18, 12);
    pdf.text(report.incidentId, 192, 12, { align: 'right' });
    pdf.setDrawColor(222, 230, 236);
    pdf.line(18, 16, 192, 16);
    y = 26;
  };
  const write = (text: string, size = 9.5, bold = false) => {
    font(size, bold);
    const height = size * 0.5;
    for (const line of wrap(text)) {
      if (y + height > bottom) newPage();
      font(size, bold);
      pdf.setTextColor(...ink);
      pdf.text(line, 18, y);
      y += height;
    }
    y += 3;
  };
  const heading = (title: string) => {
    if (y + 25 > bottom) newPage();
    y += 5;
    pdf.setFillColor(...blue);
    pdf.rect(18, y - 3.5, 1.2, 5, 'F');
    font(11, true);
    pdf.setTextColor(...ink);
    pdf.text(title, 22, y);
    y += 4;
    pdf.setDrawColor(222, 230, 236);
    pdf.line(18, y, 192, y);
    y += 7;
  };
  // A clear cover band and compact metadata leave the first page for the case.
  pdf.setFillColor(...ink);
  pdf.rect(0, 0, 210, 49, 'F');
  pdf.setFillColor(68, 177, 198);
  pdf.rect(0, 49, 210, 1.5, 'F');
  pdf.setTextColor(165, 204, 222);
  font(9, true);
  pdf.text('ACN / NETWORK OPERATIONS', 18, 13);
  pdf.setTextColor(255);
  font(23, true);
  pdf.text('Incident report', 18, 29);
  font(12);
  pdf.text(report.incidentId, 18, 41);
  const generated = new Date(report.generatedAt);
  const dateLabel = Number.isFinite(generated.getTime())
    ? generated.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : report.generatedAt;
  y = 59;
  font(8);
  pdf.setTextColor(...muted);
  pdf.text(`Generated ${dateLabel}`, 18, y);
  pdf.text('All timestamps UTC', 192, y, { align: 'right' });
  y += 7;
  const titles = ['Summary', 'Time taken', 'Diagnosis and confidence', 'Recommended next step', 'Decision and outcome', 'Timeline (UTC)', 'Evidence behind the diagnosis', 'Report notes'];
  const sections = [...report.sections].sort((a, b) => titles.indexOf(a.title) - titles.indexOf(b.title));
  for (const section of sections) {
    if (section.title === 'Evidence behind the diagnosis' && y > 35) newPage();
    heading(section.title);
    if (section.title === 'Time taken') {
      // Three aligned timing cards are easier to scan than a paragraph of durations.
      const cards = section.paragraphs.slice(0, 3).map(text => {
        const colon = text.indexOf(':');
        return { label: text.slice(0, colon), value: text.slice(colon + 1).trim().replace(/\.$/, '') };
      });
      font(8);
      const height = Math.max(...cards.map(card => wrap(card.label, 48).length * 4 + wrap(card.value, 48).length * 5 + 12));
      if (y + height + 8 > bottom) newPage();
      cards.forEach((card, index) => {
        const x = 18 + index * 59;
        pdf.setFillColor(241, 246, 249);
        pdf.roundedRect(x, y - 2, 56, height, 2, 2, 'F');
        font(8);
        pdf.setTextColor(...muted);
        const labels = wrap(card.label, 48);
        pdf.text(labels, x + 4, y + 4, { lineHeightFactor: 1.4 });
        font(10, true);
        pdf.setTextColor(...ink);
        pdf.text(wrap(card.value, 48), x + 4, y + 6 + labels.length * 4, { lineHeightFactor: 1.4 });
      });
      y += height + 5;
      for (const paragraph of section.paragraphs.slice(3)) write(paragraph, 8);
    } else if (section.title === 'Timeline (UTC)') {
      for (const paragraph of section.paragraphs) {
        const separator = paragraph.indexOf(' | ');
        const at = paragraph.slice(0, separator).replace('T', ' ').replace(/\.\d{3}Z$/, '');
        const detail = separator < 0 ? paragraph : paragraph.slice(separator + 3);
        font(8);
        const dates = wrap(at, 38);
        font(9);
        const detailLines = wrap(detail, 122);
        const rows = Math.max(dates.length, detailLines.length);
        for (let row = 0; row < rows; row++) {
          if (y + 5 > bottom) newPage();
          font(7.5);
          pdf.setTextColor(...muted);
          if (dates[row]) pdf.text(dates[row], 18, y);
          font(9);
          pdf.setTextColor(...ink);
          if (detailLines[row]) pdf.text(detailLines[row], 64, y);
          y += 4.7;
        }
        pdf.setDrawColor(232, 238, 242);
        pdf.line(64, y, 192, y);
        y += 5;
      }
    } else {
      for (const paragraph of section.paragraphs) write(paragraph, section.title === 'Report notes' ? 8 : section.title === 'Evidence behind the diagnosis' ? 8.5 : 9.5);
    }
  }
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setDrawColor(222, 230, 236);
    pdf.line(18, 280, 192, 280);
    font(7.5);
    pdf.setTextColor(...muted);
    pdf.text('ACN / Incident record', 18, 287);
    pdf.text(`${page} / ${pages}`, 192, 287, { align: 'right' });
  }
  return pdf;
}

async function fontData(filename: string): Promise<string> {
  const response = await fetch(new URL(`fonts/${filename}`, document.baseURI));
  if (!response.ok) throw new Error('Report font could not be loaded. Please retry.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export async function downloadIncidentPdf(report: IncidentReport): Promise<void> {
  const [regular, bold] = await Promise.all([fontData('DejaVuSans.ttf'), fontData('DejaVuSans-Bold.ttf')]);
  const pdf = renderIncidentPdf(report, { regular, bold });
  pdf.save(`incident-${report.incidentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`);
}
