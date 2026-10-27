def add(x: int, y: int) -> int:
    return x + y


def label(value: int | str) -> str:
    return str(value)


total = add(1, 2)


def narrow(a: int | str) -> None:
    if isinstance(a, int):
        b = a + 1
        print(b)
