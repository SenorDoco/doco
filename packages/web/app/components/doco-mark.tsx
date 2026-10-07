import { useId } from "react";
import { cn } from "~/lib/cn";

const VIEWBOX_WIDTH = 720;
const VIEWBOX_HEIGHT = 180;
const MARK_VIEWBOX_WIDTH = 180;
const ASPECT = VIEWBOX_WIDTH / VIEWBOX_HEIGHT;

interface DocoMarkProps {
  height: number;
  className?: string;
  active?: boolean;
  ariaLabel?: string;
  /** Neumorphic: solid purple standing out of the page like a key (`.doco-mark-raised`). */
  raised?: boolean;
  variant?: "logo" | "mark";
}

export function DocoMark({
  height,
  className,
  active = false,
  ariaLabel = "Doco",
  raised = false,
  variant = "logo",
}: DocoMarkProps) {
  const reactId = useId();
  const maskId = `${reactId}-mask`;
  const clipId = `${reactId}-orb-clip`;
  const showWordmark = variant === "logo";
  const viewBoxWidth = showWordmark ? VIEWBOX_WIDTH : MARK_VIEWBOX_WIDTH;
  const width = height * (showWordmark ? ASPECT : MARK_VIEWBOX_WIDTH / VIEWBOX_HEIGHT);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${viewBoxWidth} ${VIEWBOX_HEIGHT}`}
      width={width}
      height={height}
      focusable="false"
      className={cn(
        "doco-mark block",
        active && "doco-mark-active",
        raised && "doco-mark-raised",
        className,
      )}
      role="img"
      aria-label={ariaLabel}
    >
      <title>{ariaLabel}</title>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          <rect x="0" y="0" width="200" height="200" fill="white" />
          <polygon
            className="doco-mark-spark doco-mark-spark-lg"
            fill="black"
            points="86,18 89.96,32.04 104,36 89.96,39.96 86,54 82.04,39.96 68,36 82.04,32.04"
          />
          <polygon
            className="doco-mark-spark doco-mark-spark-md"
            fill="black"
            points="120,43 122.42,51.58 131,54 122.42,56.42 120,65 117.58,56.42 109,54 117.58,51.58"
          />
          <polygon
            className="doco-mark-spark doco-mark-spark-sm"
            fill="black"
            points="68,70 69.76,76.24 76,78 69.76,79.76 68,86 66.24,79.76 60,78 66.24,76.24"
          />
        </mask>
        {/* Orb circle in absolute viewBox coordinates — i.e. cx=100*0.8259+8,
            cy=82*0.8259+0.588, r=70*0.8259 — so the clipped mist group
            below can reference it without inheriting the glyph's inner
            translate+scale. */}
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <circle cx="90.59" cy="68.31" r="57.81" />
        </clipPath>
      </defs>
      <g className="doco-mark-glyph-motion">
        <g fill="#9945A1" transform="translate(8 0.588) scale(0.8259)">
          <path d="M 56 182 L 144 182 L 130 158 L 70 158 Z" />
          <circle cx="100" cy="82" r="70" mask={`url(#${maskId})`} />
        </g>
      </g>
      {showWordmark ? (
        <g fill="#9945A1" transform="translate(180 150) scale(2)">
          <path d="M23.600-56.500L23.600-12.700Q24.700-12.600 26.150-12.550Q27.600-12.500 29.600-12.500L29.600-12.500Q41.300-12.500 46.950-18.400Q52.600-24.300 52.600-34.700L52.600-34.700Q52.600-45.600 47.200-51.200Q41.800-56.800 30.100-56.800L30.100-56.800Q28.500-56.800 26.800-56.750Q25.100-56.700 23.600-56.500L23.600-56.500ZM68.700-34.700L68.700-34.700Q68.700-25.700 65.900-19Q63.100-12.300 57.950-7.900Q52.800-3.500 45.400-1.300Q38 0.900 28.800 0.900L28.800 0.900Q24.600 0.900 19 0.550Q13.400 0.200 8-0.900L8-0.900L8-68.400Q13.400-69.400 19.250-69.750Q25.100-70.100 29.300-70.100L29.300-70.100Q38.200-70.100 45.450-68.100Q52.700-66.100 57.900-61.800Q63.100-57.500 65.900-50.800Q68.700-44.100 68.700-34.700ZM129.900-26.400L129.900-26.400Q129.900-20.200 128.100-15.050Q126.300-9.900 122.900-6.250Q119.500-2.600 114.750-0.600Q110 1.400 104.100 1.400L104.100 1.400Q98.300 1.400 93.550-0.600Q88.800-2.600 85.400-6.250Q82-9.900 80.100-15.050Q78.200-20.200 78.200-26.400L78.200-26.400Q78.200-32.600 80.150-37.700Q82.100-42.800 85.550-46.400Q89-50 93.750-52Q98.500-54 104.100-54L104.100-54Q109.800-54 114.550-52Q119.300-50 122.700-46.400Q126.100-42.800 128-37.700Q129.900-32.600 129.900-26.400ZM114.700-26.400L114.700-26.400Q114.700-33.300 111.950-37.250Q109.200-41.200 104.100-41.200L104.100-41.200Q99-41.200 96.200-37.250Q93.400-33.300 93.400-26.400L93.400-26.400Q93.400-19.500 96.200-15.450Q99-11.400 104.100-11.400L104.100-11.400Q109.200-11.400 111.950-15.450Q114.700-19.500 114.700-26.400ZM138.900-26.300L138.900-26.300Q138.900-32 140.750-37.050Q142.600-42.100 146.100-45.850Q149.600-49.600 154.600-51.800Q159.600-54 166-54L166-54Q170.200-54 173.700-53.250Q177.200-52.500 180.500-51.100L180.500-51.100L177.400-39.200Q175.300-40 172.800-40.600Q170.300-41.200 167.200-41.200L167.200-41.200Q160.600-41.200 157.350-37.100Q154.100-33 154.100-26.300L154.100-26.300Q154.100-19.200 157.150-15.300Q160.200-11.400 167.800-11.400L167.800-11.400Q170.500-11.400 173.600-11.900Q176.700-12.400 179.300-13.500L179.300-13.500L181.400-1.300Q178.800-0.200 174.900 0.600Q171 1.400 166.300 1.400L166.300 1.400Q159.100 1.400 153.900-0.750Q148.700-2.900 145.350-6.600Q142-10.300 140.450-15.350Q138.900-20.400 138.900-26.300ZM238.100-26.400L238.100-26.400Q238.100-20.200 236.300-15.050Q234.500-9.900 231.100-6.250Q227.700-2.600 222.950-0.600Q218.200 1.400 212.300 1.400L212.300 1.400Q206.500 1.400 201.750-0.600Q197-2.600 193.600-6.250Q190.200-9.900 188.300-15.050Q186.400-20.200 186.400-26.400L186.400-26.400Q186.400-32.600 188.350-37.700Q190.300-42.800 193.750-46.400Q197.200-50 201.950-52Q206.700-54 212.300-54L212.300-54Q218-54 222.750-52Q227.500-50 230.900-46.400Q234.300-42.800 236.200-37.700Q238.100-32.600 238.100-26.400ZM222.900-26.400L222.900-26.400Q222.900-33.300 220.150-37.250Q217.400-41.200 212.300-41.200L212.300-41.200Q207.200-41.200 204.400-37.250Q201.600-33.300 201.600-26.400L201.600-26.400Q201.600-19.500 204.400-15.450Q207.200-11.400 212.300-11.400L212.300-11.400Q217.400-11.400 220.150-15.450Q222.900-19.500 222.900-26.400Z" />
        </g>
      ) : null}
      {/* "Crystal-ball mist" — only visible when the mark is .doco-mark-active.
          Three soft tinted blobs rotate at different speeds and directions
          inside the orb. Clipped to the orb circle. Sits in front of the
          glyph so the swirl reads cleanly over the purple fill. */}
      <g className="doco-mark-mist" clipPath={`url(#${clipId})`} aria-hidden>
        <g className="doco-mark-mist-blob doco-mark-mist-1">
          <ellipse
            cx="73.27"
            cy="53.86"
            rx="31.80"
            ry="20.23"
            fill="#e3afff"
            opacity="0.55"
            filter="blur(3px)"
          />
        </g>
        <g className="doco-mark-mist-blob doco-mark-mist-2">
          <ellipse
            cx="102.15"
            cy="78.71"
            rx="34.69"
            ry="17.34"
            fill="#ffd1f5"
            opacity="0.45"
            filter="blur(3px)"
          />
        </g>
        <g className="doco-mark-mist-blob doco-mark-mist-3">
          <ellipse
            cx="90.59"
            cy="72.93"
            rx="26.01"
            ry="14.45"
            fill="#ffffff"
            opacity="0.55"
            filter="blur(3px)"
          />
        </g>
      </g>
    </svg>
  );
}
