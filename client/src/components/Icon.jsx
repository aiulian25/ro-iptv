export default function Icon({ name, fill = false, className = '', style, ...rest }) {
  return (
    <span
      className={`material-symbols-outlined ${fill ? 'icon-fill' : ''} ${className}`}
      style={style}
      {...rest}
    >
      {name}
    </span>
  );
}
