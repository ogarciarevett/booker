import { describe, expect, it } from "vitest";
import { drivingSchoolDetail } from "@/features/errands/components/fixtures.ts";
import { parseErrandDetail, parseErrandList } from "./errands.ts";

describe("the errand answers, checked where they enter the dashboard", () => {
  it("keeps what it knows and turns a stage or status it does not know into unknown", () => {
    const list = parseErrandList({
      errands: [{ ...drivingSchoolDetail, stage: "archived", providers: undefined }],
    });
    const detail = parseErrandDetail({
      ...drivingSchoolDetail,
      stage: 42,
      providers: [{ ...drivingSchoolDetail.providers[0], status: "voicemail" }],
    });

    expect(list?.[0]).toMatchObject({ errandId: "errand-driving-school-001", stage: "unknown" });
    expect(detail?.stage).toBe("unknown");
    expect(detail?.providers[0]).toMatchObject({
      name: "Northside Driving School",
      status: "unknown",
    });
  });

  it("accepts the answers it expects as they are", () => {
    expect(parseErrandDetail(drivingSchoolDetail)).toEqual(drivingSchoolDetail);
  });

  it("refuses an answer it cannot use", () => {
    expect(parseErrandList({ errands: "none" })).toBeUndefined();
    expect(parseErrandList([])).toBeUndefined();
    expect(parseErrandDetail({ ...drivingSchoolDetail, providers: "none" })).toBeUndefined();
    expect(parseErrandDetail({ objective: "no id" })).toBeUndefined();
  });
});
