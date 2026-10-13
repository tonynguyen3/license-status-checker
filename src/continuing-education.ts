export interface CourseListRow {
  label: string;
  value: string;
}

export interface ReportedCourse {
  title: string;
  code: string;
  completed: string;
  hours: number;
  firstAidOnly: boolean;
}

export function isFirstAidOnly(title: string): boolean {
  // The outreach exception is keyword-based, regardless of provider or other title text.
  const normalized = title.replace(/[\u2010-\u2015]/g, "-");
  return /\bfirst[\s-]+aid\b/i.test(normalized);
}

export function parseReportedCourses(rows: CourseListRow[], sectionText: string): ReportedCourse[] {
  const courses: ReportedCourse[] = [];
  let fields: Map<string, string> | undefined;
  const finish = () => {
    if (!fields) return;
    const title = fields.get("course title") ?? "";
    const completed = fields.get("completed") ?? "";
    const hoursText = fields.get("course hours") ?? "";
    // Washington lists several categories in one field, e.g. 4.00 IRE,4.00 IRP.
    const parts = hoursText.split(",");
    const values = parts.map(part => /^(\d+(?:\.\d+)?)\s*(?:[A-Za-z][A-Za-z\s/-]*)?$/.exec(part.trim()));
    if (!title || !completed || !hoursText || values.some(value => !value)) {
      throw new Error("Continuing education course data is incomplete or has unrecognized hours.");
    }
    const hours = values.reduce((sum, value) => sum + Number(value![1]), 0);
    if (!Number.isFinite(hours)) throw new Error("Continuing education hours are invalid.");
    courses.push({ title, completed, code: fields.get("course code") ?? "", hours, firstAidOnly: isFirstAidOnly(title) });
  };
  for (const row of rows) {
    const label = row.label.toLowerCase().trim();
    if (label === "course title") {
      finish();
      fields = new Map();
    }
    // Spacer rows are expected; all course fields come from a single page snapshot.
    if (fields && label) fields.set(label, row.value.trim());
  }
  finish();
  if (!courses.length && !/no continuing education credits have been reported/i.test(sectionText)) {
    throw new Error("Could not confirm courses or an explicit no-credits message in the continuing education section.");
  }
  return courses;
}

export function courseExclusionReason(trade: string, courses: ReportedCourse[]): string | undefined {
  if (trade === "Plumber Trainee") {
    return courses.some(course => course.hours > 0) ? "Completed CE credits reported." : undefined;
  }
  if (trade !== "Plumber" && trade !== "Electrician") throw new Error(`Unsupported live trade: ${trade}`);
  return courses.some(course => !course.firstAidOnly) ? "Non-first-aid continuing education reported." : undefined;
}
