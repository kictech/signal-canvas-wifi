"use client";

import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Point = { x: number; y: number };
type Measurement = Point & { id: string; rssi: number };
type Room = {
  id: string;
  name: string;
  color: string;
  boundary: Point[];
  measurements: Measurement[];
};
type ToolMode = "select" | "boundary" | "measure" | "router";
type HeatMethod = "idw" | "gaussian";

type PdfPage = {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
};
type PdfDocument = {
  numPages: number;
  getPage(page: number): Promise<PdfPage>;
};
type PdfJsModule = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(options: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
};

const PDFJS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
const PDFJS_WORKER_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const initialRooms: Room[] = [
  { id: "living", name: "거실", color: "#2563eb", boundary: [], measurements: [] },
  { id: "bed-1", name: "침실 1", color: "#7c3aed", boundary: [], measurements: [] },
  { id: "bed-2", name: "침실 2", color: "#db2777", boundary: [], measurements: [] },
  { id: "bed-3", name: "침실 3", color: "#ea580c", boundary: [], measurements: [] },
];

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pointInPolygon(point: Point, polygon: Point[]) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-9) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function colorForRssi(value: number) {
  const stops = [
    { value: -90, color: [220, 38, 38] },
    { value: -75, color: [249, 115, 22] },
    { value: -65, color: [250, 204, 21] },
    { value: -55, color: [132, 204, 22] },
    { value: -30, color: [22, 163, 74] },
  ];
  const clamped = Math.max(-90, Math.min(-30, value));
  let low = stops[0];
  let high = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (clamped >= stops[i].value && clamped <= stops[i + 1].value) {
      low = stops[i];
      high = stops[i + 1];
      break;
    }
  }
  const t = (clamped - low.value) / (high.value - low.value || 1);
  return low.color.map((channel, i) =>
    Math.round(channel + (high.color[i] - channel) * t),
  );
}

function predictRssi(
  point: Point,
  measurements: Measurement[],
  method: HeatMethod,
) {
  if (!measurements.length) return null;
  let weighted = 0;
  let weights = 0;
  for (const measurement of measurements) {
    const dx = point.x - measurement.x;
    const dy = point.y - measurement.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < 0.0000001) return measurement.rssi;
    const weight =
      method === "idw"
        ? 1 / Math.pow(distanceSquared, 1)
        : Math.exp(-distanceSquared / (2 * 0.075 * 0.075));
    weighted += measurement.rssi * weight;
    weights += weight;
  }
  return weights > 0.000001 ? weighted / weights : null;
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pdfDocRef = useRef<PdfDocument | null>(null);
  const draggingRef = useRef<
    | { type: "measurement"; roomId: string; measurementId: string }
    | { type: "router" }
    | null
  >(null);

  const [fileName, setFileName] = useState("");
  const [imageReady, setImageReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("도면을 올려 시작하세요.");
  const [rooms, setRooms] = useState<Room[]>(initialRooms);
  const [activeRoomId, setActiveRoomId] = useState(initialRooms[0].id);
  const [mode, setMode] = useState<ToolMode>("select");
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(
    null,
  );
  const [router, setRouter] = useState<Point | null>(null);
  const [method, setMethod] = useState<HeatMethod>("idw");
  const [opacity, setOpacity] = useState(56);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [pdfPages, setPdfPages] = useState(0);
  const [pdfPage, setPdfPage] = useState(1);

  const activeRoom = rooms.find((room) => room.id === activeRoomId)!;
  const selectedMeasurement = useMemo(() => {
    for (const room of rooms) {
      const measurement = room.measurements.find(
        (item) => item.id === selectedMeasurementId,
      );
      if (measurement) return { room, measurement };
    }
    return null;
  }, [rooms, selectedMeasurementId]);
  const measurementCount = rooms.reduce(
    (sum, room) => sum + room.measurements.length,
    0,
  );

  const setCanvasImage = useCallback(async (source: string) => {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
      image.src = source;
    });
    const maxEdge = 2200;
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const staging = document.createElement("canvas");
    staging.width = Math.max(1, Math.round(image.width * scale));
    staging.height = Math.max(1, Math.round(image.height * scale));
    staging.getContext("2d")?.drawImage(image, 0, 0, staging.width, staging.height);
    const normalized = new Image();
    await new Promise<void>((resolve, reject) => {
      normalized.onload = () => resolve();
      normalized.onerror = () => reject(new Error("도면 변환에 실패했습니다."));
      normalized.src = staging.toDataURL("image/png");
    });
    imageRef.current = normalized;
    setImageReady(true);
  }, []);

  const renderPdfPage = useCallback(
    async (doc: PdfDocument, pageNumber: number) => {
      const page = await doc.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(
        2.2,
        2200 / Math.max(baseViewport.width, baseViewport.height),
      );
      const viewport = page.getViewport({ scale });
      const staging = document.createElement("canvas");
      staging.width = Math.round(viewport.width);
      staging.height = Math.round(viewport.height);
      const context = staging.getContext("2d");
      if (!context) throw new Error("PDF 렌더링을 시작할 수 없습니다.");
      await page.render({ canvasContext: context, viewport }).promise;
      await setCanvasImage(staging.toDataURL("image/png"));
    },
    [setCanvasImage],
  );

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!["jpg", "jpeg", "png", "pdf"].includes(extension || "")) {
      setMessage("JPG, PNG 또는 PDF 파일을 선택해 주세요.");
      return;
    }
    setLoading(true);
    setMessage("도면을 불러오는 중입니다…");
    try {
      setFileName(file.name);
      setRooms(initialRooms);
      setRouter(null);
      setSelectedMeasurementId(null);
      if (extension === "pdf") {
        const pdfjs = (await import(
          /* @vite-ignore */ PDFJS_URL
        )) as PdfJsModule;
        pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() })
          .promise;
        pdfDocRef.current = doc;
        setPdfPages(doc.numPages);
        setPdfPage(1);
        await renderPdfPage(doc, 1);
      } else {
        pdfDocRef.current = null;
        setPdfPages(0);
        setPdfPage(1);
        await setCanvasImage(URL.createObjectURL(file));
      }
      setMode("boundary");
      setMessage("거실의 네 코너를 시계 방향으로 클릭하세요.");
    } catch (error) {
      console.error(error);
      setMessage(
        extension === "pdf"
          ? "PDF를 열지 못했습니다. 인터넷 연결을 확인하거나 JPG/PNG로 변환해 주세요."
          : "도면을 열지 못했습니다. 다른 파일로 다시 시도해 주세요.",
      );
    } finally {
      setLoading(false);
    }
  };

  const changePdfPage = async (nextPage: number) => {
    const doc = pdfDocRef.current;
    if (!doc || nextPage < 1 || nextPage > doc.numPages) return;
    setLoading(true);
    setPdfPage(nextPage);
    try {
      await renderPdfPage(doc, nextPage);
      setRooms(initialRooms);
      setRouter(null);
      setMessage(`${nextPage}페이지를 불러왔습니다. 방 경계를 다시 지정하세요.`);
    } finally {
      setLoading(false);
    }
  };

  const draw = useCallback(
    (includeControls = true) => {
      const canvas = canvasRef.current;
      const image = imageRef.current;
      if (!canvas || !image) return;
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      if (showHeatmap) {
        const divisor = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 520));
        const heatCanvas = document.createElement("canvas");
        heatCanvas.width = Math.ceil(canvas.width / divisor);
        heatCanvas.height = Math.ceil(canvas.height / divisor);
        const heatContext = heatCanvas.getContext("2d");
        if (heatContext) {
          const imageData = heatContext.createImageData(
            heatCanvas.width,
            heatCanvas.height,
          );
          for (let y = 0; y < heatCanvas.height; y++) {
            for (let x = 0; x < heatCanvas.width; x++) {
              const point = {
                x: x / Math.max(1, heatCanvas.width - 1),
                y: y / Math.max(1, heatCanvas.height - 1),
              };
              const room = rooms.find(
                (candidate) =>
                  candidate.boundary.length >= 3 &&
                  candidate.measurements.length > 0 &&
                  pointInPolygon(point, candidate.boundary),
              );
              if (!room) continue;
              const prediction = predictRssi(point, room.measurements, method);
              if (prediction === null) continue;
              const [red, green, blue] = colorForRssi(prediction);
              const index = (y * heatCanvas.width + x) * 4;
              imageData.data[index] = red;
              imageData.data[index + 1] = green;
              imageData.data[index + 2] = blue;
              imageData.data[index + 3] = 255;
            }
          }
          heatContext.putImageData(imageData, 0, 0);
          context.save();
          context.globalAlpha = opacity / 100;
          context.imageSmoothingEnabled = true;
          context.drawImage(heatCanvas, 0, 0, canvas.width, canvas.height);
          context.restore();
        }
      }

      const unit = Math.max(9, Math.min(canvas.width, canvas.height) * 0.015);
      rooms.forEach((room) => {
        if (room.boundary.length) {
          context.save();
          context.strokeStyle = room.color;
          context.lineWidth = Math.max(2, unit * 0.22);
          context.setLineDash([unit * 0.55, unit * 0.35]);
          context.beginPath();
          room.boundary.forEach((point, index) => {
            const x = point.x * canvas.width;
            const y = point.y * canvas.height;
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          if (room.boundary.length === 4) context.closePath();
          context.stroke();
          context.restore();
        }
        room.measurements.forEach((measurement) => {
          const x = measurement.x * canvas.width;
          const y = measurement.y * canvas.height;
          const selected = measurement.id === selectedMeasurementId;
          context.save();
          context.fillStyle = selected ? "#0f172a" : "#ffffff";
          context.strokeStyle = selected ? "#ffffff" : "#0f172a";
          context.lineWidth = Math.max(2, unit * 0.2);
          context.beginPath();
          context.arc(x, y, selected ? unit * 0.65 : unit * 0.52, 0, Math.PI * 2);
          context.fill();
          context.stroke();
          if (showLabels) {
            context.font = `700 ${Math.round(unit * 0.92)}px Arial`;
            context.textBaseline = "middle";
            const label = `${measurement.rssi}`;
            const labelWidth = context.measureText(label).width;
            const labelX = x + unit * 0.85;
            context.fillStyle = "rgba(255,255,255,.92)";
            context.fillRect(
              labelX - unit * 0.18,
              y - unit * 0.7,
              labelWidth + unit * 0.36,
              unit * 1.4,
            );
            context.fillStyle = "#0f172a";
            context.fillText(label, labelX, y);
          }
          context.restore();
        });
      });

      if (router) {
        const x = router.x * canvas.width;
        const y = router.y * canvas.height;
        context.save();
        context.fillStyle = "#ffffff";
        context.strokeStyle = "#0f172a";
        context.lineWidth = Math.max(2, unit * 0.18);
        context.beginPath();
        context.roundRect(
          x - unit * 1.05,
          y - unit * 0.65,
          unit * 2.1,
          unit * 1.3,
          unit * 0.22,
        );
        context.fill();
        context.stroke();
        context.strokeStyle = "#2563eb";
        context.lineWidth = Math.max(2, unit * 0.16);
        [-0.45, 0, 0.45].forEach((offset) => {
          context.beginPath();
          context.moveTo(x + offset * unit, y - unit * 0.65);
          context.lineTo(x + offset * unit, y - unit * 1.05);
          context.stroke();
        });
        if (showLabels) {
          context.font = `700 ${Math.round(unit * 0.75)}px Arial`;
          context.textAlign = "center";
          context.fillStyle = "#0f172a";
          context.fillText("Wi‑Fi", x, y + unit * 1.25);
        }
        context.restore();
      }

      if (!includeControls) {
        const legendWidth = Math.min(canvas.width * 0.32, 420);
        const legendHeight = Math.max(48, canvas.height * 0.06);
        const left = canvas.width - legendWidth - 18;
        const top = canvas.height - legendHeight - 18;
        const gradient = context.createLinearGradient(
          left,
          top,
          left + legendWidth,
          top,
        );
        gradient.addColorStop(0, "#dc2626");
        gradient.addColorStop(0.25, "#f97316");
        gradient.addColorStop(0.5, "#facc15");
        gradient.addColorStop(0.72, "#84cc16");
        gradient.addColorStop(1, "#16a34a");
        context.fillStyle = "rgba(255,255,255,.94)";
        context.fillRect(left - 12, top - 28, legendWidth + 24, legendHeight + 46);
        context.fillStyle = gradient;
        context.fillRect(left, top, legendWidth, legendHeight * 0.45);
        context.fillStyle = "#0f172a";
        context.font = `700 ${Math.max(12, Math.round(legendHeight * 0.28))}px Arial`;
        context.textAlign = "left";
        context.fillText("약함 -90 dBm", left, top + legendHeight);
        context.textAlign = "right";
        context.fillText("강함 -30 dBm", left + legendWidth, top + legendHeight);
      }
    },
    [
      method,
      opacity,
      rooms,
      router,
      selectedMeasurementId,
      showHeatmap,
      showLabels,
    ],
  );

  useEffect(() => {
    draw();
  }, [draw, imageReady]);

  const normalizedPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const nearestMeasurement = (point: Point) => {
    let nearest:
      | { roomId: string; measurementId: string; distance: number }
      | undefined;
    rooms.forEach((room) =>
      room.measurements.forEach((measurement) => {
        const distance = Math.hypot(
          measurement.x - point.x,
          measurement.y - point.y,
        );
        if (!nearest || distance < nearest.distance) {
          nearest = {
            roomId: room.id,
            measurementId: measurement.id,
            distance,
          };
        }
      }),
    );
    return nearest && nearest.distance < 0.035 ? nearest : undefined;
  };

  const handleCanvasPointerDown = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (!imageReady) return;
    const point = normalizedPoint(event);
    if (mode === "boundary") {
      setRooms((current) =>
        current.map((room) =>
          room.id === activeRoomId && room.boundary.length < 4
            ? { ...room, boundary: [...room.boundary, point] }
            : room,
        ),
      );
      const nextCount = activeRoom.boundary.length + 1;
      setMessage(
        nextCount >= 4
          ? `${activeRoom.name} 경계가 완성되었습니다. 측정점을 추가하거나 다음 방을 선택하세요.`
          : `${activeRoom.name} 경계 ${nextCount}/4 — 다음 코너를 클릭하세요.`,
      );
      return;
    }
    if (mode === "measure") {
      if (
        activeRoom.boundary.length === 4 &&
        !pointInPolygon(point, activeRoom.boundary)
      ) {
        setMessage(`${activeRoom.name} 경계 안을 클릭해 주세요.`);
        return;
      }
      const measurement: Measurement = { ...point, id: uid(), rssi: -60 };
      setRooms((current) =>
        current.map((room) =>
          room.id === activeRoomId
            ? { ...room, measurements: [...room.measurements, measurement] }
            : room,
        ),
      );
      setSelectedMeasurementId(measurement.id);
      setMessage("측정점이 추가되었습니다. 오른쪽에서 RSSI 값을 입력하세요.");
      return;
    }
    if (mode === "router") {
      setRouter(point);
      draggingRef.current = { type: "router" };
      setMessage("공유기 위치를 지정했습니다. 드래그해서 옮길 수 있습니다.");
      return;
    }
    const nearest = nearestMeasurement(point);
    if (nearest) {
      setActiveRoomId(nearest.roomId);
      setSelectedMeasurementId(nearest.measurementId);
      draggingRef.current = {
        type: "measurement",
        roomId: nearest.roomId,
        measurementId: nearest.measurementId,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handleCanvasPointerMove = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    if (!draggingRef.current) return;
    const point = normalizedPoint(event);
    const dragging = draggingRef.current;
    if (dragging.type === "router") {
      setRouter(point);
      return;
    }
    setRooms((current) =>
      current.map((room) =>
        room.id === dragging.roomId
          ? {
              ...room,
              measurements: room.measurements.map((measurement) =>
                measurement.id === dragging.measurementId
                  ? { ...measurement, ...point }
                  : measurement,
              ),
            }
          : room,
      ),
    );
  };

  const endDragging = () => {
    draggingRef.current = null;
  };

  const updateSelectedRssi = (value: number) => {
    if (!selectedMeasurement || !Number.isFinite(value)) return;
    const clamped = Math.max(-100, Math.min(-20, value));
    setRooms((current) =>
      current.map((room) =>
        room.id === selectedMeasurement.room.id
          ? {
              ...room,
              measurements: room.measurements.map((measurement) =>
                measurement.id === selectedMeasurement.measurement.id
                  ? { ...measurement, rssi: clamped }
                  : measurement,
              ),
            }
          : room,
      ),
    );
  };

  const deleteSelected = () => {
    if (!selectedMeasurementId) return;
    setRooms((current) =>
      current.map((room) => ({
        ...room,
        measurements: room.measurements.filter(
          (measurement) => measurement.id !== selectedMeasurementId,
        ),
      })),
    );
    setSelectedMeasurementId(null);
    setMessage("측정점을 삭제했습니다.");
  };

  const resetBoundary = () => {
    setRooms((current) =>
      current.map((room) =>
        room.id === activeRoomId ? { ...room, boundary: [] } : room,
      ),
    );
    setMode("boundary");
    setMessage(`${activeRoom.name}의 네 코너를 다시 지정하세요.`);
  };

  const resetAll = () => {
    setRooms(initialRooms);
    setRouter(null);
    setSelectedMeasurementId(null);
    setMode("boundary");
    setMessage("모든 표시를 지웠습니다. 거실의 네 코너부터 지정하세요.");
  };

  const downloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas || !imageReady) return;
    draw(false);
    const link = document.createElement("a");
    const safeName = (fileName.replace(/\.[^.]+$/, "") || "floorplan")
      .replace(/[^\w가-힣-]+/g, "-")
      .replace(/-+/g, "-");
    link.download = `${safeName}-wifi-heatmap.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    draw(true);
    setMessage("히트맵 PNG를 다운로드했습니다.");
  };

  const chooseRoom = (room: Room) => {
    setActiveRoomId(room.id);
    setSelectedMeasurementId(null);
    if (room.boundary.length < 4) {
      setMode("boundary");
      setMessage(`${room.name}의 네 코너를 시계 방향으로 클릭하세요.`);
    } else {
      setMode("measure");
      setMessage(`${room.name} 내부를 클릭해 RSSI 측정점을 추가하세요.`);
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Wi‑Fi 공간 진단 도구</div>
          <h1>Signal Canvas</h1>
        </div>
        <div className="header-actions">
          <label className="button button-primary upload-button">
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
              onChange={handleFile}
            />
            도면 업로드
          </label>
          <button
            className="button"
            onClick={downloadPng}
            disabled={!imageReady}
          >
            PNG 다운로드
          </button>
        </div>
      </header>

      <section className="status-strip" aria-live="polite">
        <span className={`status-dot ${loading ? "loading" : ""}`} />
        <span>{loading ? "파일을 처리하고 있습니다…" : message}</span>
        {fileName && <strong>{fileName}</strong>}
      </section>

      <div className="workspace">
        <aside className="panel left-panel">
          <div className="panel-heading">
            <span>01</span>
            <div>
              <h2>공간 설정</h2>
              <p>방을 선택하고 경계를 지정하세요.</p>
            </div>
          </div>

          <div className="room-list">
            {rooms.map((room) => (
              <button
                key={room.id}
                className={`room-card ${
                  activeRoomId === room.id ? "active" : ""
                }`}
                onClick={() => chooseRoom(room)}
                style={{ "--room-color": room.color } as React.CSSProperties}
              >
                <span className="room-swatch" />
                <span className="room-main">
                  <strong>{room.name}</strong>
                  <small>
                    경계 {room.boundary.length}/4 · 측정 {room.measurements.length}개
                  </small>
                </span>
                <span className="room-chevron">›</span>
              </button>
            ))}
          </div>

          <button
            className="text-button"
            onClick={resetBoundary}
            disabled={!imageReady}
          >
            선택한 방 경계 다시 지정
          </button>

          <div className="separator" />

          <div className="panel-heading compact">
            <span>02</span>
            <div>
              <h2>도구</h2>
              <p>도면 위 작업 모드를 선택하세요.</p>
            </div>
          </div>
          <div className="tool-grid">
            {(
              [
                ["select", "선택·이동", "↖"],
                ["boundary", "방 경계", "⌗"],
                ["measure", "RSSI 추가", "+"],
                ["router", "공유기", "⌁"],
              ] as [ToolMode, string, string][]
            ).map(([tool, label, icon]) => (
              <button
                key={tool}
                className={`tool-button ${mode === tool ? "active" : ""}`}
                onClick={() => setMode(tool)}
                disabled={!imageReady}
              >
                <span>{icon}</span>
                {label}
              </button>
            ))}
          </div>

          {pdfPages > 0 && (
            <div className="pdf-pages">
              <span>PDF 페이지</span>
              <div>
                <button
                  onClick={() => changePdfPage(pdfPage - 1)}
                  disabled={pdfPage <= 1 || loading}
                >
                  이전
                </button>
                <strong>
                  {pdfPage} / {pdfPages}
                </strong>
                <button
                  onClick={() => changePdfPage(pdfPage + 1)}
                  disabled={pdfPage >= pdfPages || loading}
                >
                  다음
                </button>
              </div>
            </div>
          )}
        </aside>

        <section className="canvas-column">
          <div className="canvas-toolbar">
            <div>
              <strong>{activeRoom.name}</strong>
              <span>
                {mode === "boundary" && "네 코너를 시계 방향으로 클릭"}
                {mode === "measure" && "원하는 위치를 클릭해 측정점 추가"}
                {mode === "select" && "측정점을 선택하거나 드래그"}
                {mode === "router" && "공유기 위치를 클릭"}
              </span>
            </div>
            <div className="canvas-stats">
              <span>{rooms.filter((room) => room.boundary.length === 4).length}/4 공간</span>
              <span>{measurementCount} 측정점</span>
            </div>
          </div>

          <div className={`canvas-stage ${!imageReady ? "empty" : ""}`}>
            {!imageReady && (
              <div className="empty-state">
                <div className="empty-icon">⌑</div>
                <h2>아파트 도면을 올려주세요</h2>
                <p>
                  JPG, PNG, PDF · 파일은 이 브라우저 안에서만 처리됩니다.
                </p>
                <label className="button button-primary upload-button">
                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
                    onChange={handleFile}
                  />
                  도면 선택
                </label>
              </div>
            )}
            <canvas
              ref={canvasRef}
              className={imageReady ? `mode-${mode}` : ""}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={endDragging}
              onPointerCancel={endDragging}
              aria-label="도면 편집 영역"
            />
            {loading && (
              <div className="loading-overlay">
                <div className="spinner" />
                도면을 준비하는 중…
              </div>
            )}
          </div>

          <div className="privacy-note">
            <span>●</span>
            도면과 측정값은 서버에 저장되지 않습니다.
          </div>
        </section>

        <aside className="panel right-panel">
          <div className="panel-heading">
            <span>03</span>
            <div>
              <h2>신호 분석</h2>
              <p>보간 방식과 표현을 조절하세요.</p>
            </div>
          </div>

          <div className="form-group">
            <label>보간 방식</label>
            <div className="segmented">
              <button
                className={method === "idw" ? "active" : ""}
                onClick={() => setMethod("idw")}
              >
                IDW
              </button>
              <button
                className={method === "gaussian" ? "active" : ""}
                onClick={() => setMethod("gaussian")}
              >
                Gaussian
              </button>
            </div>
            <small>
              {method === "idw"
                ? "측정점에 가까울수록 큰 가중치를 줍니다."
                : "부드러운 영향 반경으로 신호를 표현합니다."}
            </small>
          </div>

          <div className="form-group">
            <div className="label-row">
              <label htmlFor="opacity">히트맵 투명도</label>
              <strong>{opacity}%</strong>
            </div>
            <input
              id="opacity"
              type="range"
              min="0"
              max="90"
              value={opacity}
              onChange={(event) => setOpacity(Number(event.target.value))}
            />
          </div>

          <div className="toggle-row">
            <span>
              <strong>히트맵 표시</strong>
              <small>분포 색상 레이어</small>
            </span>
            <button
              className={`toggle ${showHeatmap ? "on" : ""}`}
              onClick={() => setShowHeatmap((value) => !value)}
              aria-pressed={showHeatmap}
            >
              <span />
            </button>
          </div>
          <div className="toggle-row">
            <span>
              <strong>RSSI 숫자 표시</strong>
              <small>측정점 옆 dBm 값</small>
            </span>
            <button
              className={`toggle ${showLabels ? "on" : ""}`}
              onClick={() => setShowLabels((value) => !value)}
              aria-pressed={showLabels}
            >
              <span />
            </button>
          </div>

          <div className="legend-card">
            <div className="legend-title">
              <strong>RSSI 신호 세기</strong>
              <span>dBm</span>
            </div>
            <div className="legend-gradient" />
            <div className="legend-scale">
              <span>-90<br /><small>매우 약함</small></span>
              <span>-70</span>
              <span>-55</span>
              <span>-30<br /><small>매우 강함</small></span>
            </div>
          </div>

          <div className="separator" />

          <div className="measurement-editor">
            <div className="editor-heading">
              <div>
                <h3>선택한 측정점</h3>
                <p>
                  {selectedMeasurement
                    ? selectedMeasurement.room.name
                    : "도면에서 점을 선택하세요."}
                </p>
              </div>
              {selectedMeasurement && (
                <button onClick={deleteSelected} className="delete-button">
                  삭제
                </button>
              )}
            </div>
            <div className="rssi-input">
              <input
                type="number"
                inputMode="numeric"
                min="-100"
                max="-20"
                value={selectedMeasurement?.measurement.rssi ?? ""}
                disabled={!selectedMeasurement}
                onChange={(event) => updateSelectedRssi(Number(event.target.value))}
                aria-label="RSSI 값"
              />
              <span>dBm</span>
            </div>
            <small>-100에서 -20 dBm 사이 값을 입력하세요.</small>
          </div>

          <div className="bottom-actions">
            <button className="button button-danger" onClick={resetAll} disabled={!imageReady}>
              모든 표시 초기화
            </button>
            <button
              className="button button-primary"
              onClick={downloadPng}
              disabled={!imageReady}
            >
              결과 PNG 저장
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
