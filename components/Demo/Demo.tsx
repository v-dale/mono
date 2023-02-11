import React, {useEffect} from 'react';
import Image from 'next/image';
import {init} from '@/demo/frontend';
import {Letter} from '@/demo/shared/types';

let initPromise: Promise<void> | undefined;
const initOnce = () => {
  if (initPromise) {
    return initPromise;
  }
  initPromise = init().catch(e => {
    console.error(e);
  });
  return initPromise;
};

const PaintFight = () => {
  // useEffect so this fires after load
  useEffect(() => {
    initOnce();
  }, []);

  return (
    <>
      <pre id="debug"></pre>
      <div id="demo">
        <div id="wells">
          <canvas className="a"></canvas>
          <canvas className="l"></canvas>
          <canvas className="i"></canvas>
          <canvas className="v"></canvas>
          <canvas className="e"></canvas>
        </div>
        <div id="canvases">
          <LetterCanvas letter={Letter.A} />
          <LetterCanvas letter={Letter.L} />
          <LetterCanvas letter={Letter.I} />
          <LetterCanvas letter={Letter.V} />
          <LetterCanvas letter={Letter.E} />
        </div>
      </div>
      <canvas id="render-canvas"></canvas>
      <Textures />
      <Symbols />
      <div id="tools">
        <button id="paint-tool" className="control-button">
          <svg className="paint-icon">
            <use xlinkHref="#paint"></use>
          </svg>
        </button>
        <button id="move-tool" className="control-button">
          <svg className="move-icon">
            <use xlinkHref="#move"></use>
          </svg>
        </button>
        <button id="scale-tool" className="control-button">
          <svg className="scale-icon">
            <use xlinkHref="#scale"></use>
          </svg>
        </button>
        <button id="rotate-tool" className="control-button">
          <svg className="rotate-icon">
            <use xlinkHref="#rotate"></use>
          </svg>
        </button>
      </div>
      <div id="info">
        <div className="active-user-info">
          <div className="online-dot"></div>
          &nbsp;Active users:&nbsp;
          <span id="active-user-count">1</span>
        </div>
        <button id="copy-room-button">
          <div className="copy">
            <Image
              src="/img/copy-link.svg"
              className="icon"
              alt=""
              width={16}
              height={16}
            />
            &nbsp;Copy demo link
          </div>
          <div className="success">
            <Image
              src="/img/copied.svg"
              className="icon"
              alt=""
              width={16}
              height={16}
            />
            &nbsp;Link copied
          </div>
        </button>
        <button id="new-room-button">Reset Demo</button>
      </div>
    </>
  );
};

export default PaintFight;

const LetterCanvas = ({letter}: {letter: Letter}) => (
  <div id={letter} className="letter">
    <canvas></canvas>
    <div className="spin">
      <Image src="/img/rotate-circle.png" alt="" width={100} height={100} />
    </div>
    <div className="controls">
      <button className="move">
        <svg className="move-icon">
          <use xlinkHref="#move"></use>
        </svg>
      </button>
      <button className="scale">
        <svg className="scale-icon">
          <use xlinkHref="#scale"></use>
        </svg>
      </button>
      <button className="rotate">
        <svg className="rotate-icon">
          <use xlinkHref="#rotate"></use>
        </svg>
      </button>
    </div>
  </div>
);

const Textures = () => (
  <div id="textures">
    <canvas className="a"></canvas>
    <canvas className="l"></canvas>
    <canvas className="i"></canvas>
    <canvas className="v"></canvas>
    <canvas className="e"></canvas>
  </div>
);

const Symbols = () => (
  <svg
    id="symbol-defs"
    xmlns="http://www.w3.org/2000/svg"
    xmlnsXlink="http://www.w3.org/1999/xlink"
  >
    <symbol
      id="paint"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M10 3h2v2h-2V3z" fill="var(--button-color)" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 5h4a1 1 0 0 1 1 1v1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2V6a1 1 0 0 1 1-1zm4 1v2h1a1 1 0 0 1 1 1v1.509a4.5 4.5 0 0 0 0 8.945V20a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h1V6h4zm2 5.517v6.929a3.5 3.5 0 0 1 0-6.93z"
        fill="var(--button-color)"
      />
      <circle cx="14.5" cy="3.5" r=".5" fill="var(--button-color)" />
      <circle cx="16.5" cy="2.5" r=".5" fill="var(--button-color)" />
      <circle cx="16.5" cy="4.5" r=".5" fill="var(--button-color)" />
      <circle cx="18.5" cy="3.5" r=".5" fill="var(--button-color)" />
      <circle cx="18.5" cy="1.5" r=".5" fill="var(--button-color)" />
      <circle cx="18.5" cy="5.5" r=".5" fill="var(--button-color)" />
    </symbol>
    <symbol
      id="move"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g clipPath="url(#xfoiw2174a)">
        <path
          d="M12.025 1.625a.551.551 0 0 0-.067.007 1.064 1.064 0 0 0-.09.007h-.014l-.022.007-.03.008h-.024l-.014.007-.053.023h-.007l-.068.03v.007h-.022l-.023.015-.015.015-.014.008-.008.007a.76.76 0 0 0-.068.038.105.105 0 0 0-.007.015.684.684 0 0 0-.037.037l-.008.008a.585.585 0 0 0-.052.045l-.008.015-2.49 2.49a.818.818 0 0 0-.008 1.162.826.826 0 0 0 1.163.008l1.155-1.155v3.72a.82.82 0 0 0 1.43.626.825.825 0 0 0 .205-.634v-3.69l1.14 1.133a.82.82 0 0 0 1.41-.578c0-.22-.09-.431-.247-.585L12.709 2a1.08 1.08 0 0 0-.037-.053.308.308 0 0 0-.023-.015.544.544 0 0 0-.03-.045l-.008-.007a.734.734 0 0 0-.067-.053.783.783 0 0 0-.113-.09l-.014-.007a.794.794 0 0 0-.06-.023l-.03-.015a.644.644 0 0 0-.053-.022h-.007a.58.58 0 0 0-.068-.015.117.117 0 0 0-.015-.008.709.709 0 0 0-.06-.015H12.041l-.014-.007h-.002zM4.931 8.622a.819.819 0 0 0-.51.248l-2.423 2.422a.745.745 0 0 0-.067.06.586.586 0 0 0-.045.03l-.008.015a1.043 1.043 0 0 0-.135.18l-.015.008-.022.06-.014.03c-.009.016-.016.034-.024.052v.008a.705.705 0 0 0-.014.067c-.003.005-.006.01-.007.015a.551.551 0 0 0-.008.068c-.003.004-.006.009-.007.015v.06c-.003.004-.006.009-.008.015.001.024.004.05.008.075v.006c0 .026.003.05.007.075v.023l.008.015c.001.01.004.02.007.03v.022c.002.006.005.01.008.015a.517.517 0 0 0 .022.053v.015c.008.02.019.04.03.06l.008.007v.015l.014.023.016.022c.001.006.004.01.006.015h.008l.037.068.015.007a.45.45 0 0 0 .038.038l.007.015a.746.746 0 0 0 .053.045l.007.007 2.49 2.498a.818.818 0 0 0 1.163.007.818.818 0 0 0 .007-1.162l-1.155-1.163h3.72a.818.818 0 0 0 .9-.821.824.824 0 0 0-.907-.814H4.45l1.132-1.14a.822.822 0 0 0-.57-1.41h-.082v.001zm13.98 0a.821.821 0 0 0-.488 1.41l1.125 1.14h-3.69a.822.822 0 1 0-.007 1.635h3.727l-1.155 1.163a.821.821 0 1 0 1.163 1.155l2.49-2.498.015-.007.045-.045.015-.015.038-.038.008-.007a.824.824 0 0 0 .044-.068l.007-.015a.326.326 0 0 0 .015-.022l.015-.023.008-.016v-.006c.013-.02.026-.04.037-.06v-.015a.658.658 0 0 0 .023-.053V12.2l.015-.03v-.037a.71.71 0 0 0 .015-.075V11.9a.117.117 0 0 0-.008-.015.584.584 0 0 0-.015-.068v-.015a.853.853 0 0 0-.014-.067l-.008-.008a3.067 3.067 0 0 0-.022-.052l-.008-.03-.03-.06-.007-.008a1.26 1.26 0 0 0-.037-.06l-.053-.06-.052-.06a.117.117 0 0 1-.008-.015 1.094 1.094 0 0 0-.038-.03l-.022-.022-.045-.038-2.43-2.422a.822.822 0 0 0-.585-.248.604.604 0 0 0-.082 0h-.001zm-6.946 6.353a.822.822 0 0 0-.772.877v3.728l-1.155-1.163a.823.823 0 0 0-1.155 1.17l2.49 2.49.008.014c.016.016.034.031.052.045l.008.008a.491.491 0 0 0 .037.037l.008.016.067.038.007.006.015.008.016.015.022.015a.22.22 0 0 0 .023.007.842.842 0 0 0 .067.038h.008l.052.015.015.007h.022l.03.008.023.007h.015c.025.004.05.006.075.008h.015l.067.007a.095.095 0 0 1 .015-.007H12.123l.06-.015h.015a.988.988 0 0 0 .067-.023h.008l.053-.022.03-.008.06-.03.014-.007.053-.038c.02-.017.041-.034.06-.052a.965.965 0 0 0 .068-.053l.007-.007.03-.038.023-.022.037-.053 2.423-2.422a.823.823 0 1 0-1.163-1.163l-1.14 1.133v-3.69a.823.823 0 0 0-.862-.885z"
          fill="var(--button-color)"
        />
      </g>
      <defs>
        <clipPath id="xfoiw2174a">
          <path d="M0 0h24v24H0z" />
        </clipPath>
      </defs>
    </symbol>
    <symbol
      id="scale"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M7.3125 9.84384C7.07976 9.84384 6.86812 9.93806 6.71625 10.0913L2.53125 14.2756V12.9376C2.53125 12.4714 2.15366 12.0938 1.6875 12.0938C1.22134 12.0938 0.84375 12.4714 0.84375 12.9376V16.3126C0.84375 16.7787 1.22134 17.1563 1.6875 17.1563H5.0625C5.52866 17.1563 5.90625 16.7787 5.90625 16.3126C5.90625 15.8464 5.52866 15.4688 5.0625 15.4688H3.72445L7.90945 11.2838C8.06203 11.1319 8.15625 10.9203 8.15625 10.6876C8.15625 10.2214 7.77866 9.84384 7.3125 9.84384ZM16.3125 0.843842H12.9375C12.4713 0.843842 12.0938 1.22143 12.0938 1.68759C12.0938 2.15376 12.4713 2.53134 12.9375 2.53134H14.2755L10.0913 6.71634C9.93799 6.86892 9.84377 7.07985 9.84377 7.31259C9.84377 7.77876 10.2214 8.15634 10.6875 8.15634C10.9203 8.15634 11.1312 8.06212 11.2838 7.90884L15.4688 3.72456V5.06261C15.4688 5.52877 15.8464 5.90636 16.3125 5.90636C16.7787 5.90636 17.1563 5.52877 17.1563 5.06261V1.68761C17.1563 1.22145 16.7787 0.843842 16.3125 0.843842Z"
        fill="var(--button-color)"
      />
    </symbol>
    <symbol
      id="rotate"
      width="18"
      height="9"
      viewBox="0 0 14 7"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M13.1871 3.82054C12.865 3.82092 12.6036 3.55952 12.604 3.2374V2.17088L9.88744 4.8874C9.12062 5.65191 8.08268 6.08119 6.99999 6.08112C5.9173 6.08104 4.87932 5.65187 4.11253 4.8874L1.39601 2.17088V3.2374C1.3906 3.55526 1.13112 3.81087 0.812874 3.81048C0.494616 3.81087 0.23515 3.55526 0.229737 3.2374L0.229737 0.762523C0.229351 0.440403 0.490757 0.178997 0.812876 0.179383L3.28775 0.179383C3.60561 0.184798 3.86123 0.444274 3.86083 0.762521C3.86122 1.08078 3.60561 1.34025 3.28775 1.34566L2.22124 1.34566L4.93776 4.06218C5.48493 4.60858 6.22698 4.91521 7.00006 4.91488C7.77306 4.91527 8.51515 4.60862 9.06236 4.06218L11.7789 1.34566H10.7124C10.3945 1.34024 10.1389 1.08077 10.1393 0.76252C10.1389 0.444261 10.3945 0.184796 10.7124 0.179383L13.1872 0.179383C13.5094 0.178997 13.7708 0.440402 13.7704 0.762522L13.7704 3.2374C13.7708 3.55952 13.5092 3.82092 13.1871 3.82054Z"
        fill="var(--button-color)"
      />
    </symbol>
  </svg>
);
